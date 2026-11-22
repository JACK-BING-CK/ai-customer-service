export const traceKinds = {
  'order.placed':'顾客下单', 'order.recorded':'后台录入订单', 'order.imported':'Excel 导入订单',
  'order.updated':'订单资料更新', 'order.historical':'历史订单留存',
  'checkout.blocked':'模拟下单被拦截', 'checkout.failed':'模拟下单异常',
  'session.created':'建立客服会话', 'customer.message':'收到顾客消息',
  'ai.started':'开始生成回答', 'ai.completed':'AI 回复已保存', 'ai.failed':'AI 回答失败',
  'ai.cancelled':'AI 生成已取消', 'commerce.started':'开始业务查询', 'commerce.failed':'业务查询失败',
  'commerce.cancelled':'业务查询已取消', 'identity.checked':'核验顾客身份', 'orders.lookup':'核对本人订单',
  'policy.lookup':'检索问答或政策', 'eligibility.checked':'判断退货资格', 'commerce.reply':'业务答复已保存',
  'system.message':'系统通知已保存', 'handoff.waiting':'进入人工队列', 'agent.claimed':'坐席接单',
  'agent.reply':'坐席回复已保存', 'session.resolved':'坐席办结', 'customer.resolved':'顾客确认问题已解决', 'session.reopened':'顾客追问重开',
  'feedback.captured':'坐席登记反馈', 'feedback.draft':'运营保存修订', 'feedback.replayed':'历史案例回放',
  'feedback.published':'修订已发布', 'feedback.publish_blocked':'拦截修订发布',
} as const
export type TraceKind = keyof typeof traceKinds
export type TraceStatus = 'ok'|'blocked'|'error'|'info'
export interface TraceOrderRef {shop:string; owner:string; orderId:string}
export type TraceDetails = Record<string,string|number|boolean>
export const traceDetailLabels: Record<string,string> = {
  code:'结果代码', queryKind:'查询类型', versions:'引用条款版本', deadline:'截止时间（北京时间）',
  line:'订单行', quantity:'数量', elapsedMs:'耗时（毫秒）', messageId:'消息编号', causeMessageId:'来源消息编号',
  caseId:'运营案例编号', revision:'修订', source:'资料来源', sku:'商品编码', orderedAt:'下单时间',
  passed:'通过数', total:'案例数', reason:'原因', target:'修订类型',
}
export interface TraceEvent {
  sequence:number
  id:string
  flowId:string|null
  conversationId:string|null
  order:TraceOrderRef|null
  kind:TraceKind
  label:string
  status:TraceStatus
  at:number
  details:TraceDetails
}
export interface TraceQuery {q?:string; cursor?:number; limit?:number}
export interface TracePage {
  query:string
  events:TraceEvent[]
  nextCursor:number|null
  coverageSince:number
  legacy:boolean
  matched:boolean
  selectedEvent?:TraceEvent
}
