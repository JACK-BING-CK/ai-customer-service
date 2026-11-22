import {randomUUID} from 'node:crypto'
import {appendTrace} from './trace-store.ts'
import type {DatabaseSync,SQLOutputValue} from 'node:sqlite'
import type {CommerceCard,CommerceQuery} from '../shared/commerce.ts'
import {feedbackReasons,policyRefPattern,type FeedbackCase,type FeedbackDraftInput,type FeedbackExpected,type FeedbackInput} from '../shared/feedback.ts'
import {storeTime} from './commerce-rules.ts'
import {orderFacts,parseCommerceQuery} from './commerce.ts'
import {chatPriority,type FaqReplayRoute} from './commerce-request.ts'
import {cleanRow,parseFaq,parsePolicy} from './merchant-records.ts'
import type {openMerchant} from './merchant-store.ts'
import type {DemoOrder} from './commerce-fixtures.ts'
import {runFeedbackReplay,type HistoryCase,type HistoryFacts} from './feedback-replay.ts'

export class FeedbackError extends Error {
  readonly code:'invalid'|'not_found'|'not_claimed'|'stale'|'replay_required'|'replay_blocked'|'unavailable'
  constructor(code:FeedbackError['code'],message:string) {super(message);this.code=code}
}

function invalid(message:string):never {throw new FeedbackError('invalid',message)}
function expectedValue(expected:FeedbackExpected):FeedbackExpected {
  if (expected?.kind==='none') return {kind:'none'}
  if (expected?.kind==='faq' && typeof expected.answer==='string' && expected.answer.trim() && expected.answer.length<=8000) {
    return {kind:'faq',answer:expected.answer.trim()}
  }
  if (expected?.kind==='policy' && ['eligible','expired','review'].includes(expected.status)) {
    const {status,versions,deadline}=expected
    if (versions!==undefined && (!Array.isArray(versions) || versions.length>50 || versions.some(ref=>typeof ref!=='string' || !policyRefPattern.test(ref)))) {
      return invalid('预期条款版本请填写「条款编号@版本」，每行一条。')
    }
    if (deadline!==null && deadline!==undefined) {
      const timestamp=typeof deadline==='string'?Date.parse(deadline.replace(' ','T')+'+08:00'):NaN
      if (!Number.isFinite(timestamp) || storeTime(timestamp)!==deadline) return invalid('预期截止时间须为有效的北京时间，精确到秒。')
    }
    return {kind:'policy',status,...(versions!==undefined && {versions:[...new Set(versions)].sort()}),...(deadline!==undefined && {deadline})}
  }
  return invalid('请填写预期的完整问答或选择退货判断。')
}

export function openFeedback(db:DatabaseSync,merchant:ReturnType<typeof openMerchant>) {
  db.exec(`CREATE TABLE IF NOT EXISTS feedback_cases (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), message_id TEXT NOT NULL,
    record TEXT NOT NULL, evidence TEXT NOT NULL, signature TEXT, UNIQUE(conversation_id,message_id)
  ) STRICT`)
  const byId=db.prepare('SELECT record FROM feedback_cases WHERE id=?')
  const existing=db.prepare('SELECT record FROM feedback_cases WHERE conversation_id=? AND message_id=?')
  const read=(r:Record<string,SQLOutputValue>|undefined):FeedbackCase|null=>r?JSON.parse(String(r.record)):null
  function get(id:string) {return read(byId.get(id))}
  function list(conversationId?:string):FeedbackCase[] {
    const rows=conversationId===undefined?db.prepare('SELECT record FROM feedback_cases ORDER BY rowid DESC').all():
      db.prepare('SELECT record FROM feedback_cases WHERE conversation_id=? ORDER BY rowid DESC').all(conversationId)
    return rows.map(r=>read(r)!)
  }
  function transaction<T>(work:()=>T):T {
    db.exec('BEGIN IMMEDIATE')
    try {const result=work();db.exec('COMMIT');return result}
    catch(error) {db.exec('ROLLBACK');throw error}
  }
  function getCase(id:string) {
    const entry=get(id)
    if (!entry) throw new FeedbackError('not_found','没有找到这条反馈。')
    return entry
  }
  function requireVersion(entry:FeedbackCase,version:number) {
    if (entry.version!==version) throw new FeedbackError('stale','反馈已更新，请刷新后重新核对。')
    if (entry.status==='published') throw new FeedbackError('stale','该修订已经发布，请刷新查看记录。')
  }
  function save(entry:FeedbackCase,signature:string|null=null) {
    entry.version++
    db.prepare('UPDATE feedback_cases SET record=?, signature=? WHERE id=?').run(JSON.stringify(entry),signature,entry.id)
    return entry
  }
  function policyFacts(id:string,card:CommerceCard|null,query:CommerceQuery|null):HistoryFacts {
    if (!card?.orderId || card.kind!=='return' || !['eligible','expired','review'].includes(card.status) || query?.kind!=='return') {
      return invalid('政策案例需选择已核验本人订单且生成退货判断卡的原问题。')
    }
    const at=Date.parse(card.asOf.replace(' ','T')+'+08:00')
    if (!Number.isFinite(at)) return invalid('历史卡片缺少判断时间。')
    const saved=db.prepare('SELECT facts FROM commerce_case_evidence WHERE conversation=? AND card=?').get(id,JSON.stringify(card))
    const privateOrder=saved?.facts
    if (privateOrder) return {order:JSON.parse(String(privateOrder)),time:at,partial:query.partial}
    // Older sessions predate structured evidence. Only use the bound customer's order when every
    // historical transaction and shipping fact still matches the original card.
    const row=db.prepare('SELECT o.payload FROM commerce_accounts a JOIN commerce_orders o ON a.account=o.owner WHERE a.conversation=? AND o.id=?').get(id,card.orderId)
    const order:DemoOrder|null=row?JSON.parse(String(row.payload)):null
    if (!order || JSON.stringify(orderFacts(order,()=>undefined))!==JSON.stringify(card.facts.filter(f=>!f.label.startsWith('当前商品资料 · ')))) {
      throw new FeedbackError('unavailable','此历史卡的订单事实无法还原。可仅标记原因，或选有完整证据的退货判断卡。')
    }
    return {order,time:at,partial:query.partial}
  }
  function messageRoute(id:string,messageId:string):FaqReplayRoute {
    const message=db.prepare("SELECT sequence,text,commerce_query,faq_route FROM messages WHERE conversation_id=? AND id=? AND role='customer'").get(id,messageId)
    if (!message) return 'unknown'
    if (typeof message.faq_route==='string') return message.faq_route as FaqReplayRoute
    const previous=db.prepare('SELECT commerce_card FROM messages WHERE conversation_id=? AND sequence<? AND commerce_card IS NOT NULL ORDER BY sequence DESC LIMIT 1').get(id,message.sequence)
    const card:CommerceCard|null=previous?JSON.parse(String(previous.commerce_card)):null
    const text=String(message.text)
    const query:CommerceQuery|null=message.commerce_query?JSON.parse(String(message.commerce_query)):null
    const priority=chatPriority(text,card)
    if (priority!=='chat') {
      // A recorded structured query proves the legacy customer explicitly used a button past this chat-only priority.
      if (query) return query.kind==='faq'?'explicit_faq':'explicit_order'
      return priority
    }
    if (!query) {
      const reply=db.prepare('SELECT role FROM messages WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT 1').get(id,message.sequence)
      if (reply?.role!=='assistant') return 'unknown'
    }
    const own=db.prepare('SELECT o.id FROM commerce_orders o JOIN commerce_accounts a ON o.owner=a.account WHERE a.conversation=?').all(id).map(row=>String(row.id))
    const ifApproved=parseCommerceQuery(text,card?.orderId,own,true)
    if (query?.kind==='faq' && ifApproved?.kind!=='faq') return 'unknown'
    return ifApproved?.kind==='faq'?'chat':'order'
  }
  function capture(conversationId:string,input:FeedbackInput) {
    return transaction(()=>{
      const conversation=db.prepare('SELECT mode,handoff_reason FROM conversations WHERE id=?').get(conversationId)
      if (!conversation) throw new FeedbackError('not_found','会话不存在。')
      if (conversation.mode!=='human') throw new FeedbackError('not_claimed','坐席须先开始接待，再标记转人工原因。')
      if (!input || !Object.hasOwn(feedbackReasons,input.reason) || typeof input.messageId!=='string' ||
          (input.note!==undefined && (typeof input.note!=='string' || input.note.length>2000))) return invalid('请核对转人工原因、原问题和备注。')
      const expected=expectedValue(input.expected)
      if (expected.kind!=='none' && !input.messageId) return invalid('可回放案例必须选择顾客原问题。')
      const repeated=read(existing.get(conversationId,input.messageId))
      const note=input.note?.trim() ?? ''
      if (repeated) {
        if (repeated.reason===input.reason && repeated.note===note && JSON.stringify(repeated.expected)===JSON.stringify(expected)) return repeated
        return invalid('此原问题已经登记，历史反馈和预期已锁定。')
      }
      if (expected.kind==='policy' && (expected.versions===undefined || expected.deadline===undefined)) {
        return invalid('政策回放须同时标注预期条款版本和截止时间；没有适用版本或截止时间时请明确勾选。')
      }
      const message=db.prepare("SELECT sequence,text,commerce_query FROM messages WHERE conversation_id=? AND id=? AND role='customer'").get(conversationId,input.messageId)
      if (input.messageId && !message) return invalid('请选择当前会话中的顾客原问题。')
      const following=message?db.prepare("SELECT role,text,commerce_card FROM messages WHERE conversation_id=? AND sequence>? AND role IN ('customer','assistant','agent','system') ORDER BY sequence LIMIT 1").get(conversationId,message.sequence):undefined
      const assistant=following?.role==='assistant'?following:null
      const card:CommerceCard|null=assistant?.commerce_card?JSON.parse(String(assistant.commerce_card)):null
      const query:CommerceQuery|null=message?.commerce_query?JSON.parse(String(message.commerce_query)):null
      if (expected.kind==='faq' && query && query.kind!=='faq') return invalid('本人订单问题须按订单原有权限和政策判断处理，请选择政策预期或仅标记原因。')
      const facts:HistoryFacts=expected.kind==='policy'?policyFacts(conversationId,card,query):{}
      if (expected.kind!=='none') facts.faqRoute=messageRoute(conversationId,input.messageId)
      if (card?.sources.length) facts.sourceIds=card.sources.map(source=>source.id)
      const entry:FeedbackCase={id:randomUUID(),version:1,conversationId,messageId:input.messageId,reason:input.reason,note,expected,
        createdAt:Date.now(),question:String(message?.text ?? '（顾客直接转人工）'),originalAnswer:String(assistant?.text ?? '该问题未取得系统答复'),
        handoffReason:String(conversation.handoff_reason ?? ''),status:'new',draft:null,replay:null,draftVersion:null,publishedAt:null}
      db.prepare('INSERT INTO feedback_cases VALUES(?,?,?,?,?,NULL)').run(entry.id,conversationId,entry.messageId,JSON.stringify(entry),JSON.stringify(facts))
      appendTrace(db,{conversationId,kind:'feedback.captured',at:entry.createdAt,dedupeKey:'case:'+entry.id,
        details:{caseId:entry.id,reason:entry.reason,...(entry.messageId && {messageId:entry.messageId})}})
      return entry
    })
  }
  function saveDraft(id:string,input:FeedbackDraftInput,version:number) {
    return transaction(()=>{
      const entry=getCase(id)
      requireVersion(entry,version)
      if (!input || !['faq','policy'].includes(input.kind) || input.kind!==entry.expected.kind) return invalid('修订类型须与该案例的预期一致。')
      const kind=input.kind==='faq'?'faqs':'policies'
      let draft:FeedbackDraftInput
      let targetId:string, targetVersion:string
      try {
        const row=cleanRow(kind,input.row)
        if (input.kind==='faq') {
          row.状态='草稿'
          const faq=parseFaq(row)
          targetId=faq.id;targetVersion=faq.version
          const contrasts=input.contrastQuestions ?? []
          if (!Array.isArray(contrasts) || contrasts.length>20 || contrasts.some(q=>typeof q!=='string' || !q.trim() || q.trim().length>300)) {
            return invalid('最多填写 20 条易混淆问法，每条为 1 至 300 字。')
          }
          draft={kind:input.kind,row,...(contrasts.length?{contrastQuestions:[...new Set(contrasts.map(q=>q.trim()))]}:{})}
        } else {
          row.发布状态='草稿'
          const policy=parsePolicy(row)
          if (!Array.isArray(input.orderIds) || input.orderIds.length!==2 || input.orderIds.some(o=>typeof o!=='string' || !o.trim() || o.length>64) ||
              new Set(input.orderIds).size!==2) return invalid('政策修订须选择两笔不同的对照订单。')
          targetId=policy.id;targetVersion=policy.version
          draft={kind:input.kind,row,orderIds:input.orderIds.map(o=>o.trim().toUpperCase())}
        }
      } catch(error) {return invalid(error instanceof Error?error.message:'修订资料格式错误。')}
      const taken=kind==='faqs'?db.prepare('SELECT 1 FROM commerce_faq WHERE id=? AND version=?'):db.prepare('SELECT 1 FROM commerce_policies WHERE id=? AND version=?')
      if (taken.get(targetId,targetVersion)) return invalid('编号和版本已存在，请为反馈修订填写新版本。')
      const owner=db.prepare('SELECT case_id FROM merchant_feedback_targets WHERE kind=? AND id=? AND version=?').get(kind,targetId,targetVersion)
      if (owner && owner.case_id!==id) return invalid('此版本已有另一条反馈草稿，请选择新版本。')
      db.prepare('INSERT INTO merchant_feedback_targets VALUES(?,?,?,?) ON CONFLICT(case_id) DO UPDATE SET kind=excluded.kind,id=excluded.id,version=excluded.version').run(id,kind,targetId,targetVersion)
      const saved=save({...entry,draft,replay:null,draftVersion:entry.version+1,status:'draft'})
      appendTrace(db,{kind:'feedback.draft',conversationId:entry.conversationId,details:{caseId:id,revision:saved.version,target:draft.kind}})
      return saved
    })
  }
  function calculate(entry:FeedbackCase) {
    if (!entry.draft) throw new FeedbackError('replay_required','请先保存用于回放的修订草稿。')
    const history:HistoryCase[]=db.prepare('SELECT record,evidence FROM feedback_cases ORDER BY rowid').all().map(r=>{
      const entry=read(r)!
      const facts:HistoryFacts=JSON.parse(String(r.evidence))
      if (!facts.faqRoute && entry.expected.kind!=='none') facts.faqRoute=messageRoute(entry.conversationId,entry.messageId)
      return {entry,facts}
    })
    return runFeedbackReplay(db,merchant,entry,history)
  }
  function replay(id:string,version:number) {
    return transaction(()=>{
      const entry=getCase(id)
      requireVersion(entry,version)
      const {report,signature}=calculate(entry)
      const saved=save({...entry,replay:report,status:report.passed?'passed':'blocked'},signature)
      const checks=[...report.rows,...(report.faqContrasts ?? [])]
      appendTrace(db,{kind:'feedback.replayed',conversationId:entry.conversationId,status:report.passed?'ok':'blocked',
        details:{caseId:id,revision:entry.draftVersion!,total:checks.length,passed:checks.filter(c=>c.passed).length}})
      return saved
    })
  }
  function publish(id:string,version:number) {
    const published=transaction(()=>{
      const entry=getCase(id)
      if (entry.status==='published' && (version===entry.version || version===entry.version-1)) return entry
      requireVersion(entry,version)
      if (entry.status==='blocked') throw new FeedbackError('replay_blocked','历史回放未通过，请修订后再回放。')
      if (!entry.draft || entry.status!=='passed') throw new FeedbackError('replay_required','发布前必须通过本版草稿的历史案例回放。')
      const {report,signature,trial}=calculate(entry)
      if (!report.passed || db.prepare('SELECT signature FROM feedback_cases WHERE id=?').get(id)?.signature!==signature) {
        // Commit the invalidation so a refresh in another operator's tab cannot show a stale approval.
        save({...entry,replay:null,status:'draft'})
        return null
      }
      const {row,kind,orderIds}=entry.draft
      const result=kind==='faq'?merchant.apply({faqs:[{...row,状态:'已审核'}]},true,id):merchant.apply({policies:[row]},true,id)
      if (!result.ok) return invalid(result.errors.join(' '))
      if (kind==='policy') merchant.publish(row.条款编号+'@'+row.版本,orderIds!,trial!.token,id)
      db.prepare('DELETE FROM merchant_feedback_targets WHERE case_id=?').run(id)
      appendTrace(db,{kind:'feedback.published',conversationId:entry.conversationId,details:{caseId:id,revision:entry.draftVersion!,target:kind}})
      return save({...entry,status:'published',publishedAt:Date.now()},signature)
    })
    if (!published) throw new FeedbackError('stale','历史案例或店铺资料已变化，请重新回放后发布。')
    return published
  }
  function publishWithTrace(id:string,version:number) {
    try { return publish(id,version) }
    catch (error) {
      const item=get(id)
      if (item && error instanceof FeedbackError) appendTrace(db,{kind:'feedback.publish_blocked',conversationId:item.conversationId,status:'blocked',
        details:{caseId:id,reason:error.code,...(item.draftVersion && {revision:item.draftVersion})}})
      throw error
    }
  }
  return {get,list,capture,saveDraft,replay,publish:publishWithTrace}
}
