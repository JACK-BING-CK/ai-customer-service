import {createHash} from 'node:crypto'
import {replayFaqContrasts} from './faq-contrast.ts'
import type {DatabaseSync} from 'node:sqlite'
import {policyCheckDetail,policyStatusLabels,type FeedbackCase,type FeedbackReplay,type FeedbackReplayRow,type PolicyReplayCheck} from '../shared/feedback.ts'
import type {DemoFaq,DemoOrder,ReturnPolicy} from './commerce-fixtures.ts'
import {evaluateReturn,matchFaqs,matchPolicies} from './commerce-rules.ts'
import type {FaqReplayRoute} from './commerce-request.ts'
import {parseFaq,parsePolicy} from './merchant-records.ts'
import type {openMerchant} from './merchant-store.ts'

/** Private, immutable order facts are kept outside public case responses and diagnostics. */
export interface HistoryFacts {order?:DemoOrder; time?:number; partial?:boolean; faqRoute?:FaqReplayRoute; sourceIds?:string[]}
export interface HistoryCase {entry:FeedbackCase; facts:HistoryFacts}
interface Answer {text:string; ids:string[]; versions:string[]; matches:boolean; checks?:PolicyReplayCheck[]}
const reserved:Record<Exclude<FaqReplayRoute,'chat'|'explicit_faq'>,string>={
  handoff:'聊天入口会按顾客请求直接转人工。',basis:'聊天入口优先解释上一张退货卡的判断依据。',
  order:'聊天入口优先核验本人订单与对应政策。',explicit_order:'顾客使用了查单或退货按钮。',
  in_service:'这条消息发送时已进入人工接待。',unknown:'历史记录缺少可核验的顾客入口。',
}
function unavailable(text:string):Answer {return {text,ids:[],versions:[],matches:false}}

function answerFaq(entry:FeedbackCase, facts:HistoryFacts, faqs:DemoFaq[]):Answer {
  const hits=matchFaqs(entry.question,faqs)
  const route=facts.faqRoute ?? 'unknown'
  if (route!=='chat' && route!=='explicit_faq') return unavailable(reserved[route])
  if (hits.length!==1) return {text:hits.length>1?'多个已审核问答同时匹配':'未命中适用问答',ids:hits.map(f=>f.id),versions:[],matches:false}
  const faq=hits[0]
  return {text:faq.text,ids:[faq.id],versions:[faq.id+'@'+faq.version],
    matches:entry.expected.kind==='faq' && faq.text.trim()===entry.expected.answer}
}

function answerPolicy(entry:FeedbackCase,facts:HistoryFacts,policies:ReturnPolicy[],faqs:DemoFaq[]):Answer {
  if (!facts.order || facts.time===undefined) return {text:'缺少原订单事实',ids:[],versions:[],matches:false}
  if (facts.faqRoute==='chat' && matchFaqs(entry.question,faqs).length) return unavailable('当前已审核问答会优先接收这条聊天消息，无法命中退货政策。')
  if (facts.faqRoute!=='chat' && facts.faqRoute!=='order' && facts.faqRoute!=='explicit_order') return unavailable('无法从相同顾客入口重现这次退货查询。')
  const hits=matchPolicies(facts.order,policies)
  const decision=evaluateReturn(facts.order,hits,facts.time,facts.partial)
  const versions=[...new Set(hits.map(p=>p.id+'@'+p.version))].sort()
  const expected=entry.expected
  if (expected.kind!=='policy') return unavailable('此案例没有政策预期。')
  const checks:PolicyReplayCheck[]=[{field:'status',expected:policyStatusLabels[expected.status],
    actual:policyStatusLabels[decision.status],passed:expected.status===decision.status}]
  if (expected.versions!==undefined) {
    const refs=[...expected.versions].sort()
    checks.push({field:'versions',expected:refs.join('、') || '无适用版本',actual:versions.join('、') || '无适用版本',
      passed:refs.length===versions.length && refs.every((ref,index)=>ref===versions[index])})
  }
  if (expected.deadline!==undefined) checks.push({field:'deadline',expected:expected.deadline ?? '无截止时间',
    actual:decision.deadline ?? '无截止时间',passed:expected.deadline===decision.deadline})
  return {text:[policyStatusLabels[decision.status],hits.map(p=>p.id+' '+p.version).join('、'),decision.deadline,decision.reason].filter(Boolean).join(' · '),
    ids:hits.map(p=>p.id),versions,checks,matches:checks.every(check=>check.passed)}
}

export function runFeedbackReplay(db:DatabaseSync, merchant:ReturnType<typeof openMerchant>, target:FeedbackCase, history:HistoryCase[]) {
  const draft=target.draft!
  const faq=draft.kind==='faq'?{...parseFaq(draft.row),published:true}:null
  const policy=draft.kind==='policy'?{...parsePolicy(draft.row),published:true}:null
  const candidate=faq ?? policy!
  const key=candidate.id+'@'+candidate.version
  const issues:string[]=[]
  let trial:ReturnType<typeof merchant.trial>|undefined
  if (policy) {
    try {
      trial=merchant.trial(key,draft.orderIds ?? [],{...policy,published:false})
      issues.push(...trial.issues)
    } catch(error) {issues.push(error instanceof Error?error.message:'政策对照试算失败。')}
  }
  const approvedFaqs:DemoFaq[]=db.prepare('SELECT payload FROM commerce_faq WHERE published=1 ORDER BY id,version').all().map(r=>JSON.parse(String(r.payload)))
  const activePolicies:ReturnPolicy[]=db.prepare('SELECT payload FROM commerce_policies WHERE published=1 ORDER BY id,version').all().map(r=>JSON.parse(String(r.payload)))
  const nextFaqs=faq?[...approvedFaqs.filter(f=>f.id!==faq.id),faq]:approvedFaqs
  const nextPolicies=policy?[...activePolicies,policy]:activePolicies
  const modifiedFaqs=faq?[...approvedFaqs.filter(f=>f.id===faq.id),faq]:[]
  const rows:FeedbackReplayRow[]=[]
  const proof:unknown[]=[]
  for (const {entry,facts} of history) {
    if (entry.expected.kind==='none') continue
    const affectedPolicyChat=faq && entry.expected.kind==='policy' && facts.faqRoute==='chat' &&
      matchFaqs(entry.question,modifiedFaqs).length>0
    if (entry.expected.kind!==draft.kind && !affectedPolicyChat) continue
    const isFaqCase=entry.expected.kind==='faq'
    const before=isFaqCase?answerFaq(entry,facts,approvedFaqs):answerPolicy(entry,facts,activePolicies,approvedFaqs)
    const after=isFaqCase?answerFaq(entry,facts,nextFaqs):answerPolicy(entry,facts,nextPolicies,nextFaqs)
    const primary=entry.id===target.id
    const linkedId=entry.draft?.row[faq?'问答编号':'条款编号']
    if (!primary && !affectedPolicyChat && linkedId!==candidate.id && !facts.sourceIds?.includes(candidate.id) &&
        !before.ids.includes(candidate.id) && !after.ids.includes(candidate.id)) continue
    const reached=after.versions.includes(key)
    const passed=after.matches && (!primary || reached)
    const differences=after.checks?.filter(check=>!check.passed).map(policyCheckDetail) ?? []
    if (primary && !reached) differences.unshift('原问题未命中本次草稿。')
    const detail=differences.join(' ') || (!after.matches?'草稿结果与坐席标注的预期不一致。':
      before.matches?'修改后仍符合预期。':'修改后符合预期。')
    const expected=entry.expected.kind==='faq'?entry.expected.answer:policyStatusLabels[entry.expected.status]
    rows.push({caseId:entry.id,question:entry.question,expected,before:before.text,after:after.text,passed,detail,
      ...(after.checks && {checks:after.checks})})
    proof.push([entry.id,entry.expected,before,after])
    if (!passed) issues.push('案例 '+entry.id.slice(-6).toUpperCase()+'：'+detail)
  }
  if (!rows.length) issues.push('没有可核对的历史案例。')
  const contrasts=faq ? replayFaqContrasts(target,history.map(h=>h.entry),nextFaqs) : []
  for (const check of contrasts) {
    if (!check.passed) issues.push('易混淆问法「'+check.question+'」误命中 '+check.excludedId+'。请核对本次修订的常用问法和别名。')
  }
  if (contrasts.length) proof.push(contrasts)
  const report:FeedbackReplay={at:Date.now(),passed:issues.length===0,rows,issues}
  if (contrasts.length) report.faqContrasts=contrasts
  if (trial) report.orderTrial={asOf:trial.asOf,results:trial.results,issues:trial.issues}
  // Excludes wall clock and process-local trial tokens so completed reviews survive a restart.
  const signature=createHash('sha256').update(JSON.stringify([draft,proof,trial?.results,issues,report.passed])).digest('hex')
  return {report,signature,trial}
}
