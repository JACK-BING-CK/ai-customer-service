import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openCommerce, parseCommerceQuery } from '../server/commerce.ts'
import { replayPolicyChange } from '../server/commerce-rules.ts'
import { demoPolicies, demoOrders } from '../server/commerce-fixtures.ts'

test('accounts require matching test credentials and reveal only their own orders', async () => {
  const db = new DatabaseSync(':memory:')
  const shop = openCommerce(db)
  try {
    assert.deepEqual(shop.state('a').orders, [])
    assert.equal(shop.login('a', 'A', '2222'), false)
    assert.equal(shop.state('a').account, null)
    assert.equal((await shop.ask('a', { kind: 'order', orderId: 'DEMO-1001' })).card.status, 'login_required')
    assert.equal(shop.login('a', 'A', '1111'), true)
    assert.equal(shop.login('a', 'B', '2222'), false)
    assert.equal(shop.state('a').account, 'A')
    assert.ok(shop.state('a').orders.some(order => order.id === 'DEMO-1001'))
    assert.ok(!shop.state('a').orders.some(order => order.id === 'DEMO-2001'))
    assert.equal(shop.login('b', 'B', '2222'), true)
    const other = await shop.ask('b', { kind: 'order', orderId: 'DEMO-1001' })
    const missing = await shop.ask('b', { kind: 'order', orderId: 'DEMO-9999' })
    assert.deepEqual(other, missing)
    assert.equal(other.card.status, 'not_found')
    assert.doesNotMatch(JSON.stringify(other), /1001|旅行杯/)
  } finally { db.close() }
})

test('orders bought before and at the version cutover use their original rule and signed date', async () => {
  const shop = openCommerce(':memory:')
  try {
    shop.login('x', 'A', '1111')
    const lookup = await shop.ask('x', { kind: 'order', orderId: 'DEMO-1001' })
    assert.equal(lookup.card.status, 'found')
    assert.ok(lookup.card.facts.some(fact => fact.label.includes('物流更新') && fact.value.includes('11-16')))
    const old = await shop.ask('x', { kind: 'return', orderId: 'DEMO-1001' })
    const current = await shop.ask('x', { kind: 'return', orderId: 'DEMO-1002' })
    assert.deepEqual([old.card.status, old.card.sources[0].version, old.card.deadline], ['expired', 'V1', '2026-11-23 23:59:59'])
    assert.deepEqual([current.card.status, current.card.sources[0].version, current.card.deadline], ['eligible', 'V2', '2026-11-30 23:59:59'])
    assert.equal(current.handoff, false)
    assert.equal(shop.state('x').latestCard, null)
    shop.saveCard('x', current.card)
    assert.deepEqual(shop.state('x').latestCard, current.card)
  } finally { shop.close() }
})

test('the final day stays eligible through its last millisecond, followed by deterministic expiry', async () => {
  let now = Date.parse('2026-11-23T23:59:59.999+08:00')
  const shop = openCommerce(':memory:', { now: () => now })
  try {
    shop.login('x', 'A', '1111')
    const query = { kind: 'return' as const, orderId: 'DEMO-1001' }
    assert.equal((await shop.ask('x', query)).card.status, 'eligible')
    now++
    assert.equal((await shop.ask('x', query)).card.status, 'expired')
  } finally { shop.close() }
})

test('absent delivery receipt and equally applicable clauses need human review with evidence', async () => {
  const shop = openCommerce(':memory:')
  try {
    shop.login('x', 'A', '1111')
    const unsigned = await shop.ask('x', { kind: 'return', orderId: 'DEMO-1003' })
    assert.equal(unsigned.handoff, true)
    assert.equal(unsigned.card.deadline, null)
    assert.ok(unsigned.card.missing.some(field => field.includes('签收')))
    const ambiguous = await shop.ask('x', { kind: 'return', orderId: 'DEMO-1005' })
    assert.equal(ambiguous.handoff, true)
    assert.equal(ambiguous.card.status, 'review')
    assert.equal(ambiguous.card.deadline, null)
    assert.equal(ambiguous.card.sources.length, 2)
  } finally { shop.close() }
})

test('approved FAQ aliases cite the same source and unknown policy questions hand off', async () => {
  const shop = openCommerce(':memory:')
  try {
    const a = await shop.ask('guest', { kind: 'faq', question: '退货怎么申请？' })
    const b = await shop.ask('guest', { kind: 'faq', question: '请问，怎样办理退货？' })
    assert.deepEqual(a.card.sources, b.card.sources)
    assert.equal(a.card.sources.length, 1)
    assert.equal(a.card.status, 'found')
    const unsupported = await shop.ask('guest', { kind: 'faq', question: '退货补贴多少？' })
    assert.equal(unsupported.handoff, true)
    assert.deepEqual(unsupported.card.sources, [])
  } finally { shop.close() }
})

test('order timeout traces stop at orders, and an externally cancelled lookup publishes no outcome', async () => {
  const traces: {step:string; code:string}[] = []
  const shop = openCommerce(':memory:', {
    orderTimeoutMs: 10,
    orderReader: () => new Promise(() => {}),
    onTrace: (_id, trace) => traces.push(trace),
  })
  try {
    shop.login('x', 'A', '1111')
    traces.length = 0
    const timeout = await shop.ask('x', { kind: 'return', orderId: 'DEMO-1001' })
    assert.equal(timeout.handoff, true)
    assert.deepEqual(traces.map(t => [t.step,t.code]), [['identity','verified'], ['orders','lookup_started'], ['orders','timeout']])
    assert.deepEqual(timeout.card.facts, [])
    assert.ok(!JSON.stringify(traces).includes('DEMO-1001'))
    traces.length = 0
    const controller = new AbortController()
    const request = shop.ask('x', { kind: 'return', orderId: 'DEMO-1001' }, controller.signal)
    controller.abort()
    await assert.rejects(request, { name: 'AbortError' })
    assert.deepEqual(traces.map(t => [t.step,t.code]), [['identity','verified'], ['orders','lookup_started']])
    assert.equal(shop.state('x').latestCard, null)
  } finally { shop.close() }
})

test('natural language keeps explicit references ahead of context and routes policy questions safely', () => {
  assert.deepEqual(parseCommerceQuery('这笔还能退吗', 'DEMO-1002'), { kind: 'return', orderId:'DEMO-1002' })
  assert.deepEqual(parseCommerceQuery('查一下 DEMO-9999 的物流', 'DEMO-1002'), { kind:'order',orderId:'DEMO-9999' })
  assert.deepEqual(parseCommerceQuery('订单 987654321 可以退吗', 'DEMO-1002'), { kind:'return',orderId:'987654321' })
  assert.deepEqual(parseCommerceQuery('怎样办理退货？', 'DEMO-1002'), { kind:'faq',question:'怎样办理退货？' })
  assert.equal(parseCommerceQuery('你好！'), null)
})

test('several orders, partial items and unfamiliar explicit IDs never silently reuse the last order', async () => {
  const previous = 'DEMO-1002'
  assert.deepEqual(parseCommerceQuery('这件能不能退', previous), {kind:'return', orderId:previous})
  assert.deepEqual(parseCommerceQuery('那 SF-UNKNOWN 还能退吗', previous), {kind:'return', orderId:'SF-UNKNOWN'})
  assert.deepEqual(parseCommerceQuery('DEMO-1001 和 DEMO-1002 能退吗', previous), {kind:'return', orderId:''})
  assert.deepEqual(parseCommerceQuery('买了两件想退一件', previous), {kind:'return', orderId:'', partial:true})
  assert.equal(parseCommerceQuery('早上好', previous), null)
  assert.equal(parseCommerceQuery('fixture-private-customer-question', previous), null)
  assert.deepEqual(parseCommerceQuery('DEMO-1002'), {kind:'order',orderId:previous})
  assert.deepEqual(parseCommerceQuery('查一下 SF-UNKNOWN', previous), {kind:'order',orderId:'SF-UNKNOWN'})
  const partial = parseCommerceQuery('DEMO-1002 买了两件想退一件', previous)!
  const shop = openCommerce(':memory:')
  try {
    shop.login('x','A','1111')
    const {card,handoff} = await shop.ask('x', partial)
    assert.equal(card.orderId, previous)
    assert.equal(card.status, 'review')
    assert.equal(handoff,true)
    assert.ok(card.missing.some(field => field.includes('商品')))
  } finally { shop.close() }
})

test('a typed line and quantity are explicit, while an incomplete selection asks for the missing detail', () => {
  assert.deepEqual(parseCommerceQuery('订单 DEMO-1002 第 2 行想退 3 件，可以退吗？'),
    {kind:'return',orderId:'DEMO-1002',line:2,quantity:3})
  assert.deepEqual(parseCommerceQuery('订单 DEMO-1002 第 2 行能退吗？'),
    {kind:'return',orderId:'DEMO-1002',partial:true})
  assert.deepEqual(parseCommerceQuery('这单第 2 行想退 1 件','DEMO-1002'),
    {kind:'return',orderId:'DEMO-1002',line:2,quantity:1})
})

test('publishing a dated replacement leaves historical orders unchanged and explains affected cases', () => {
  const v2 = demoPolicies.find(p => p.version === 'V2')!
  const before = demoPolicies.filter(p => p.version === 'V1').map(p => ({ ...p, end:null }))
  const orders = demoOrders.filter(o => ['DEMO-1001','DEMO-1002'].includes(o.id))
  const changes = replayPolicyChange(orders, before, demoPolicies, Date.parse('2026-11-24T00:00:00+08:00'))
  assert.equal(changes[0].changed, false)
  assert.equal(changes[1].changed, true)
  assert.equal(changes[1].before.status, 'expired')
  assert.equal(changes[1].after.status, 'eligible')
  assert.equal(changes[1].after.version, v2.version)
  assert.match(changes[1].reason, /V1.*V2/)
})
