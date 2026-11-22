import { demoOrders, demoPolicies, DEMO_NOW } from '../server/commerce-fixtures.ts'
import { replayPolicyChange, storeTime } from '../server/commerce-rules.ts'

const before = demoPolicies.filter(p => p.version === 'V1').map(p => ({ ...p, end: null }))
const orders = demoOrders.filter(o => o.id === 'DEMO-1001' || o.id === 'DEMO-1002')
const states = { eligible: '可申请', expired: '已过期', review: '待核查' }
console.log(`模拟发布 V2 前后，按北京时间 ${storeTime(DEMO_NOW)} 回放同一组订单。`)
for (const change of replayPolicyChange(orders, before, demoPolicies, DEMO_NOW)) {
  const format = value => `${value.version} · ${states[value.status]} · 截止 ${value.deadline ?? '待核查'}`
  console.log(`${change.orderId}  ${format(change.before)} → ${format(change.after)}\n  ${change.reason}`)
}
