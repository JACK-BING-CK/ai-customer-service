import { feedbackReasons, policyCheckDetail, policyRefPattern, policyStatusLabels, type PolicyMismatch } from '../shared/feedback.ts'
import { feedbackModuleLabels, type FeedbackModuleId, type ModuleStatus } from '../shared/diagnostics.ts'
import type { TraceEntry } from './diagnostic-log.ts'

export interface FeedbackTrace { caseId: string; revisionId?: number; node: FeedbackModuleId; blocked: boolean; blockReason?: keyof typeof publishBlocks; affectedCases?:string[] }

const publishBlocks = {
  replay_required: '这次修订还没有历史回放结果。',
  replay_failed: '历史回放未通过，草稿还不能发布。',
  stale_replay: '草稿、案例或店铺资料已变化，需要重新回放。',
  version_changed: '操作页面的版本已过期，请重新读取当前修订。',
  policy_conflict: '政策版本冲突，当前草稿还不能发布。',
  policy_trial_required: '政策尚未通过新旧订单试算。',
  already_published: '这次修订已经发布。',
} as const
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
function knownText(values: Readonly<Record<string, string>>, key: unknown) {
  return typeof key === 'string' && Object.hasOwn(values, key) ? values[key] : undefined
}

function diagnosticMismatch(raw:unknown):PolicyMismatch[] {
  if (!raw || typeof raw!=='object' || !('caseId' in raw) || typeof raw.caseId!=='string' || !uuid.test(raw.caseId) ||
      !('field' in raw) || !('expected' in raw) || !('actual' in raw) || typeof raw.expected!=='string' || typeof raw.actual!=='string') return []
  const {caseId,field,expected,actual}=raw
  const both=[expected,actual]
  if (field==='status' && both.every(value=>Object.values<string>(policyStatusLabels).includes(value)) ||
      field==='deadline' && both.every(value=>value==='无截止时间' || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) ||
      field==='versions' && both.every(value=>value==='无适用版本' || value.length<=6500 && value.split('、').every(v=>policyRefPattern.test(v)))) {
    return [{caseId,field,expected,actual}]
  }
  return []
}

export function feedbackEvent(raw: Record<string, unknown>, at: number, conversationId: string): TraceEntry | undefined {
  const { caseId, revisionId, event, passed, total } = raw
  if (typeof caseId !== 'string' || !uuid.test(caseId) || typeof event !== 'string') return
  const version = typeof revisionId === 'number' && Number.isSafeInteger(revisionId) && revisionId > 0 ? revisionId : undefined
  if (event !== 'case_recorded' && event !== 'publish_blocked' && !version) return
  const context = [
    '会话 ' + conversationId.slice(-6).toUpperCase(), '案例 ' + caseId.slice(-6).toUpperCase(),
    version && '修订 ' + version, raw.target === 'faq' ? '常见问答' : raw.target === 'policy' ? '政策' : undefined,
  ].filter(Boolean).join(' · ')
  const counts = typeof passed === 'number' && typeof total === 'number' && Number.isSafeInteger(passed) &&
    Number.isSafeInteger(total) && passed >= 0 && passed <= total && total >= 0 ? `历史案例通过 ${passed} / ${total}。` : ''
  const differences=Array.isArray(raw.policyMismatches)?raw.policyMismatches.slice(0,30).flatMap(diagnosticMismatch):[]
  const differenceText=differences.map(check=>'案例 '+check.caseId.slice(-6).toUpperCase()+' · '+policyCheckDetail(check)).join(' ')
  const entry = (node: FeedbackModuleId, label: string, detail: string, blocked = false): TraceEntry => {
    return { at, module: 'feedback', event, stage: 'feedback', conversationId, failed: blocked,
      label, detail: `${context}。 ${detail}`, feedback: { caseId, revisionId: version, node, blocked,
        ...(differences.length && {affectedCases:[...new Set(differences.map(check=>check.caseId))]}) } }
  }
  switch (event) {
    case 'case_recorded': return entry('feedback', '已记录原因', '转人工原因：' + (knownText(feedbackReasons, raw.reasonCode) ?? '已记录') + '。')
    case 'revision_saved': return entry('revision', '草稿已保存', '运营已根据坐席反馈保存草稿。')
    case 'replay_passed': return entry('replay', '回放通过', counts + '已通过发布前回放检查。')
    case 'replay_failed': {
      const cause = knownText({ policy_trial: '政策草稿未通过新旧订单试算。', case_mismatch: '草稿对历史问题的回答与坐席预期不一致。', faq_contrast:'易混淆问法误命中这条问答。运营反馈页可核对原话和实际匹配条款。' }, raw.replayIssue)
      return entry('replay', '回放未通过', counts + (differenceText || cause || '草稿未通过检查，具体案例与预期见运营后台。'), true)
    }
    case 'publish_succeeded': return entry('publication', '已发布', '通过回放的修订已写入店铺资料。')
    case 'publish_blocked': {
      const reason = knownText(publishBlocks, raw.blockReason)
      const result = entry('publication', '发布被拦截', (reason ?? '发布条件尚未满足。') + differenceText, true)
      if (reason) result.feedback!.blockReason = raw.blockReason as keyof typeof publishBlocks
      return result
    }
  }
}

// Keep one case and its current draft together so an unrelated success cannot clear a block.
export function feedbackModules(traces: TraceEntry[], readable: boolean): ModuleStatus[] {
  const latest = traces.findLast(e => e.feedback)
  const chain = latest ? traces.filter(e => e.feedback?.caseId === latest.feedback!.caseId && e.conversationId === latest.conversationId) : []
  const version = chain.findLast(e => e.feedback!.revisionId)?.feedback?.revisionId
  const draft = chain.filter(e => e.feedback!.revisionId === version)
  const current = new Map<FeedbackModuleId, TraceEntry>()
  const recorded = chain.findLast(e => e.event === 'case_recorded')
  if (recorded) current.set('feedback', recorded)
  for (const entry of draft) {
    const { node, blockReason } = entry.feedback!
    if (node === 'revision') current.delete('replay')
    if (node === 'revision' || node === 'replay') current.delete('publication')
    if (blockReason === 'stale_replay') current.set('replay', { ...entry, label: '需要重新回放' })
    if (blockReason === 'already_published') {
      if (current.get('publication')?.event !== 'publish_succeeded') {
        current.set('publication', { ...entry, label: '已发布', feedback: { ...entry.feedback!, blocked: false } })
      }
    } else current.set(node, entry)
  }
  return (Object.keys(feedbackModuleLabels) as FeedbackModuleId[]).map(id => {
    const last = current.get(id)
    const recentBlocks = chain.filter(e => e.feedback!.node === id && e.feedback!.blocked)
      .slice(-10).reverse().map(e => ({ at: e.at, status: e.label, details: [e.detail], feedbackCaseIds:e.feedback!.affectedCases }))
    return { id, label: feedbackModuleLabels[id], state: !readable ? 'unknown' : !last ? 'idle' : last.feedback!.blocked ? 'blocked' : 'ok',
      status: last?.label ?? (readable ? '暂无记录' : '记录不足'), at: last?.at ?? null,
      detail: last?.detail ?? (readable ? '近期日志中还没有对应的操作记录。' : '运行日志暂不可读取。'), recentBlocks,
      ...(last && {feedbackCaseId:last.feedback!.caseId}) }
  })
}

export function earlierFeedbackCases(traces: TraceEntry[], readable: boolean) {
  const grouped = new Map<string, TraceEntry[]>()
  for (const entry of traces) {
    if (!entry.feedback) continue
    const id = entry.feedback.caseId
    const events = grouped.get(id) ?? []
    events.push(entry)
    grouped.delete(id)
    grouped.set(id, events)
  }
  return [...grouped.entries()].reverse().slice(1, 10).map(([caseId, events]) => ({ caseId, modules: feedbackModules(events, readable) }))
}
