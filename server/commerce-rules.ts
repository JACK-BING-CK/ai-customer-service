import type { DemoOrder, ReturnPolicy } from './commerce-fixtures.ts'
import type {DemoFaq} from './commerce-fixtures.ts'

export function normalizeQuestion(value: string) {
  return value.replace(/[\s，。！？,.!?、：:]/gu,'').replace(/^(?:您好|你好|请问|我想问下|我想知道)*/u,'').replace(/(?:呢|啊|呀|谢谢)*$/u,'')
}

export function matchFaqs(question:string, approved:DemoFaq[]) {
  const term=normalizeQuestion(question)
  return approved.filter(faq=>faq.published && faq.aliases.includes(term))
}

const day = 86400000
const shopOffset = 8 * 3600000

/** Fixtures all use the store's Asia/Shanghai business calendar. */
export function storeTime(timestamp: number): string {
  return new Date(timestamp + shopOffset).toISOString().slice(0,19).replace('T', ' ')
}

export function matchPolicies(order: DemoOrder, rules: ReturnPolicy[]) {
  const campaigns = order.lines?.map(line => line.campaign) ?? [order.campaign]
  const winners: ReturnPolicy[] = []
  for (const campaign of new Set(campaigns)) {
    const started = rules.filter(rule => rule.published && rule.shop === order.shop && rule.channel === order.channel &&
      rule.campaign === campaign && rule.start <= order.boughtAt)
    // An expired replacement must not resurrect an older open-ended version of the same clause.
    const latest = new Map<string,number>()
    for (const rule of started) latest.set(rule.id,Math.max(latest.get(rule.id) ?? -Infinity,rule.start))
    const active = started.filter(rule => rule.start === latest.get(rule.id) && (rule.end === null || order.boughtAt < rule.end))
    const top = Math.max(...active.map(rule => rule.priority))
    winners.push(...active.filter(rule => rule.priority === top))
  }
  return winners
}

export function evaluateReturn(order: DemoOrder, matched: ReturnPolicy[], now: number, partial=false) {
  if (partial && matched.length===1) return {
    status:'review' as const, code:'missing_fact', deadline:null, reason:'需要确认本次要退的商品行和数量，坐席将按对应明细复核。', missing:['待退商品明细及数量'],
  }
  if (order.lines && (new Set(order.lines.map(item => item.campaign)).size > 1 || new Set(order.lines.map(item => item.signedAt)).size > 1)) {
    return {status:'review' as const, code:'line_review', deadline:null,
      reason:'订单明细的成交活动或签收时间不同，需按待退商品逐行核对适用政策。', missing:['待退商品行及该行的办理期限']}
  }
  if (matched.length !== 1) {
    const reason = matched.length ? '多条同优先级政策同时适用，需核对有效版本。' : '未找到适用的已发布政策。'
    return { status: 'review' as const, code: matched.length ? 'conflict' : 'missing_policy',
      deadline: null, reason, missing: ['唯一适用的已发布条款'] }
  }
  if (order.signedAt === null || order.signedAt > now) {
    return { status: 'review' as const, code: 'missing_fact', deadline: null,
      reason: '缺少截至判断时间的签收记录，无法起算退货期限。', missing: ['签收时间'] }
  }
  const rule = matched[0]
  const receiptDay = Math.floor((order.signedAt + shopOffset) / day)
  // Signing day is day zero. The first instant after the last eligible calendar day is exclusive.
  const expires = (receiptDay + rule.days + 1) * day - shopOffset
  if (rule.reviewText) {
    return {status:'review' as const, code:'condition_review', deadline:storeTime(expires - 1),
      reason:`按 ${rule.version} 的时限字段从签收次日起计 ${rule.days} 个日历日。条款原文还需人工核对，坐席将确认完整办理条件。`, missing:['条款原文中的办理条件及对应商品情况']}
  }
  const status = now < expires ? 'eligible' as const : 'expired' as const
  const reason = `下单时适用 ${rule.version}，签收次日开始计算 ${rule.days} 个日历日；按北京时间判断${status === 'eligible' ? '仍在' : '已超过'}申请期限。`
  return { status, code: status, deadline: storeTime(expires - 1), reason, missing: [] }
}

/** Read-only pre-publication comparison, using identical order facts and evaluation clock on both sides. */
export function replayPolicyChange(orders: DemoOrder[], before: ReturnPolicy[], after: ReturnPolicy[], now: number) {
  function run(order: DemoOrder, policies: ReturnPolicy[]) {
    const matched = matchPolicies(order, policies)
    const decision = evaluateReturn(order, matched, now)
    return { status: decision.status, version: matched.map(item => item.version).sort().join(' / '),
      deadline: decision.deadline, reason: decision.reason }
  }
  return orders.map(order => {
    const previous = run(order, before)
    const next = run(order, after)
    const changed = previous.version !== next.version || previous.status !== next.status || previous.deadline !== next.deadline || previous.reason !== next.reason
    return { orderId: order.id, before: previous, after: next, changed,
      reason: changed ? `原规则 ${previous.version || '未命中'} → 新规则 ${next.version || '未命中'}。${next.reason}` : '相同订单事实仍匹配原有规则，判断一致。' }
  })
}
