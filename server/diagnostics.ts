import type { DiagnosticEvent, DiagnosticQuery, DiagnosticReport, DiagnosticSession,
  FlowStage, FlowStageId, ModuleStatus, SessionSummary, StageState } from '../shared/diagnostics.ts'
import type { Role } from '../shared/protocol.ts'
import { createTraceReader, type TraceEntry } from './diagnostic-log.ts'
import { businessModules } from './diagnostic-commerce.ts'
import { earlierFeedbackCases, feedbackModules } from './diagnostic-feedback.ts'
import type { Store } from './store.ts'

interface Options {
  logPath: string
  activeAI: (id: string) => boolean
  activeCommerce?: (id: string) => boolean
  activeCount?: () => number
  connections: (selectedId?: string) => { customers: number; agents: number; selectedCustomers?: number
    customerViews?: number; agentViews?: number; selectedCustomerViews?: number; selectedAgentViews?: number; lastViewAt?: number | null }
  aiConfigured: () => boolean
}

const stageLabels = {
  customer: '建立会话', ai: 'AI 应答', queue: '转人工排队', agent: '坐席接单', reply: '人工回复',
}
const roles: Record<Role | 'commerce', { label: string; stage: DiagnosticEvent['stage'] }> = {
  customer: { label: '顾客消息已保存', stage: 'customer' },
  assistant: { label: 'AI 回复已保存', stage: 'ai' },
  agent: { label: '人工回复已保存', stage: 'reply' },
  system: { label: '系统通知已保存', stage: 'queue' },
  commerce: { label: '业务办理卡已保存', stage: 'commerce' },
}
function stage(id: FlowStageId, state: StageState, detail: string, at: number | null = null): FlowStage {
  return { id, state, detail, at, label: stageLabels[id] }
}
type Evidence = NonNullable<ReturnType<Store['diagnosticSession']>>

function aiStage(data: Evidence, traces: TraceEntry[], running: boolean, coverage: boolean) {
  const ai = traces.findLast(e => e.module === 'ai')
  const saved = data.totals.find(r => r.role === 'assistant')
  if (running) return stage('ai', 'active', '会话服务正在生成本次回复。', ai?.event === 'generation_started' ? ai.at : null)
  const failureHandoff = traces.findLast(e => e.event === 'mode_changed' && e.reason === 'ai_failure')
  if (failureHandoff && !ai?.failed && (!ai || failureHandoff.at >= ai.at)) {
    return stage('ai', 'failed', '转人工记录注明 AI 失败，具体错误未记录。', failureHandoff.at)
  }
  if (saved && (!ai || saved.latest > ai.at || ai.event === 'generation_completed')) {
    return stage('ai', 'done', `已保存 ${saved.count} 条 AI 回复。`, saved.latest)
  }
  if (ai?.failed) return stage('ai', 'failed', ai.detail, ai.at)
  if (ai?.event === 'generation_cancelled' || ai?.event === 'generation_discarded') {
    return stage('ai', 'cancelled', ai.detail || '本次生成已停止。', ai.at)
  }
  if (ai?.event === 'generation_completed') return stage('ai', 'done', ai.label, ai.at)
  if (ai) return stage('ai', 'unknown', '已记录生成开始，缺少本次生成的结束记录。', ai.at)
  if (coverage && traces.some(e => e.module === 'commerce' && e.event === 'started')) {
    return stage('ai', 'skipped', '由订单与政策模块办理，尚无模型调用记录。')
  }
  if (data.mode === 'ai' && !data.totals.some(m => m.role === 'customer')) return stage('ai', 'pending', '等待顾客提问。')
  if (data.mode !== 'ai' && coverage && traces.some(e => e.event === 'mode_changed' && (e.reason === 'customer_handoff' || e.reason === 'customer_message'))) {
    return stage('ai', 'skipped', '会话已转人工，此前没有观察到模型调用。')
  }
  return stage('ai', 'unknown', '缺少可核对的模型运行记录。')
}

function describe(data: Evidence, traces: TraceEntry[], running: boolean, logReadable: boolean, activeCommerce?: (id: string) => boolean): DiagnosticSession {
  const { id, mode, createdAt, updatedAt } = data
  const coverage = logReadable && traces.some(e => e.module === 'session' && e.event === 'created')
  const queue = traces.findLast(e => e.event === 'mode_changed' && e.stage === 'queue')
  const claim = traces.findLast(e => e.event === 'mode_changed' && e.reason === 'agent_claim')
  const handled = mode === 'human' || mode === 'resolved'
  const reopened = data.lifecycle.findLast(entry => entry.kind === 'reopened')
  const agentReply = data.totals.find(r => r.role === 'agent')
  const selfResolved=mode==='resolved' && data.lifecycle.at(-1)?.by==='customer'
  const stages = [
    stage('customer', 'done', 'SQLite 已保存会话编号。', createdAt),
    aiStage(data, traces, running, coverage),
    ...(selfResolved ? [
      stage('queue','skipped','顾客已确认问题解决，无需进入人工队列。'),
      stage('agent','skipped','本次咨询由顾客自助办结。'),
      stage('reply','skipped','本次咨询无需人工回复。'),
    ] : [stage('queue', mode === 'ai' ? 'pending' : mode === 'waiting' ? 'active' : 'done',
      mode === 'ai' ? '尚未进入人工队列。' : reopened ? '顾客在已办结的原会话追问，重新进入人工队列。' :
        queue ? queue.detail || queue.label : '已进入过人工队列，转入时间未记录。', reopened?.at ?? queue?.at),
    stage('agent', handled ? 'done' : 'pending',
      handled ? claim ? claim.detail || claim.label : '会话已由人工接管，接单时间未记录。' : '等待坐席接单。', handled ? claim?.at : null),
    stage('reply', agentReply ? 'done' : mode === 'human' ? 'active' : 'pending',
      agentReply ? `已保存 ${agentReply.count} 条人工回复。` : mode === 'human' ? '坐席已接单，等待发送首条回复。' : '接单后可以发送人工回复。', agentReply?.latest)]),
  ]
  const events: DiagnosticEvent[] = [
    { at: createdAt, stage: 'customer', module: 'storage', event: 'created', label: '会话已建立', detail: '', failed: false },
    ...data.history.map(({ role, at }) => ({ at, module: 'storage', event: role + '_message',
      label: roles[role].label, stage: roles[role].stage, detail: '', failed: false })),
    ...data.lifecycle.map(({kind,at,by}): DiagnosticEvent => by==='customer'
      ? {at,stage:'customer',module:'conversation',event:'resolved',label:'顾客确认已解决',detail:'顾客收到回复并确认问题已解决，会话已归档。',failed:false}
      : kind === 'resolved'
      ? {at,stage:'agent',module:'conversation',event:'resolved',label:'坐席已办结',detail:'原会话已移出待办，聊天与判断依据归档。',failed:false}
      : {at,stage:'queue',module:'conversation',event:'reopened',label:'顾客追问重开',detail:'新消息已保存到原会话，重新等待坐席接单。',failed:false}),
    ...traces.filter(e => e.module !== 'session' && e.reason !== 'agent_resolved' && e.reason !== 'customer_reopened' && e.reason !== 'customer_resolved')
      .map(({ conversationId: _id, reason: _reason, feedback: _feedback, ...event }) => event),
  ]
  events.sort((a, b) => a.at - b.at)
  const historyLimited = !coverage || events.length > 80 || data.totals.reduce((total, m) => total + m.count, 0) > data.history.length
  const commerce = businessModules(traces, logReadable, 'session', coverage, activeCommerce)
  return { id, mode, createdAt, updatedAt, stages, events: events.slice(-80), historyLimited, commerce, lifecycle:data.lifecycle,
    feedback: feedbackModules(traces, logReadable), otherFeedback: earlierFeedbackCases(traces, logReadable) }
}

function modelStatus(options: Options, entries: TraceEntry[], logReadable: boolean): ModuleStatus {
  const base = { id: 'ai', label: 'DeepSeek 模型' } as const
  if (!options.aiConfigured()) return { ...base, state: 'error', status: '缺少配置', detail: '未检测到模型访问密钥。', at: null }
  const count = options.activeCount?.()
  const active = count === 0 ? undefined
    : entries.findLast(e => e.event === 'generation_started' && options.activeAI(e.conversationId))
  if (count || active) {
    return { ...base, state: 'active', status: '正在生成',
      detail: count ? `会话服务正在执行 ${count} 个生成任务。` : '服务端观察到正在执行的生成任务。',
      at: logReadable ? active?.at ?? null : null }
  }
  const last = entries.findLast(e => e.module === 'ai' && (e.event === 'generation_completed' || e.event === 'generation_failed'))
  if (logReadable && last) return { ...base, state: last.failed ? 'error' : 'ok', status: last.failed ? '最近生成失败' : '最近生成成功',
    detail: last.detail || '最近一次有结果的模型调用已保存回复。', at: last.at }
  return { ...base, state: 'idle', status: '已配置', detail: '尚无可核对的近期调用结果。', at: null }
}

export function createDiagnostics(store: Store, options: Options) {
  const readTrace = createTraceReader(options.logPath)
  return {
    read(query: DiagnosticQuery = {}): DiagnosticReport {
      const checkedAt = Date.now()
      const { entries, shop, recentBlocks, available: logReadable } = readTrace()
      const search = (query.search ?? '').trim().toLowerCase()
      let sessions: SessionSummary[] = []
      let data: Evidence | null = null
      let counts: ReturnType<Store['diagnosticCounts']> | undefined
      try {
        if (!search || /^[0-9a-f-]{1,36}$/.test(search)) sessions = store.diagnosticSessions(search)
        const id = query.id ?? sessions[0]?.id
        if (id) data = store.diagnosticSession(id)
        counts = store.diagnosticCounts()
      } catch {
        sessions = []
        data = null
      }
      const selected = data ? describe(data, entries.filter(e => e.conversationId === data.id), options.activeAI(data.id), logReadable, options.activeCommerce) : null
      const connections = options.connections(selected?.id)
      const { customers, agents } = connections
      const evidence = { requestAt: checkedAt, logReadable, connections: { customers, agents,
        selectedCustomers: connections.selectedCustomers ?? null,
        customerViews: connections.customerViews ?? null, agentViews: connections.agentViews ?? null,
        selectedCustomerViews: connections.selectedCustomerViews ?? null, selectedAgentViews: connections.selectedAgentViews ?? null,
        lastViewAt: connections.lastViewAt ?? null } }
      const lastRoute = entries.findLast(e => e.module === 'conversation')
      const queueDetail = counts ? `AI 接待 ${counts.ai} 个，等待 ${counts.waiting} 个，人工接待 ${counts.human} 个，已办结 ${counts.resolved} 个。` : '会话数量暂不可读取。'
      const routingError = logReadable && lastRoute?.failed
      const modules: ModuleStatus[] = [
        { id: 'storage', label: '会话存储', state: counts ? 'ok' : 'error', status: counts ? '读取正常' : '读取失败',
          detail: counts ? '已执行 SQLite 会话查询。' : '本次 SQLite 读取失败，请检查数据库文件和运行日志。', at: checkedAt },
        { id: 'realtime', label: '实时连接', state: 'ok', status: '已响应',
          detail: `顾客连接 ${customers} 个，坐席连接 ${agents} 个。`, at: checkedAt },
        modelStatus(options, entries, logReadable),
        { id: 'routing', label: '会话调度', state: routingError ? 'error' : !counts ? 'unknown' : lastRoute && logReadable ? 'ok' : 'idle',
          status: routingError ? '最近推送失败' : !counts ? '待核查' : lastRoute && logReadable ? '已记录流转' : '待观察',
          detail: queueDetail, at: logReadable ? lastRoute?.at ?? null : null },
        ...businessModules(entries, logReadable, 'instance', true, options.activeCommerce),
        ...feedbackModules(entries, logReadable),
        { id: 'merchant', label: '店铺资料管理', recentBlocks, state: shop?.block ? 'blocked' : shop ? 'ok' : logReadable ? 'idle' : 'unknown',
          status: shop?.status ?? (logReadable ? '近期无记录' : '记录不足'),
          detail: shop?.detail ?? (logReadable ? '近期日志中没有店铺级录入、导入、试算或发布记录。' : '店铺级操作日志暂不可读取。'), at: shop?.at ?? null },
      ]
      return { checkedAt, sessions, selected, modules, evidence }
    },
  }
}
