import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { openStore } from '../server/store.ts'
import { createService } from '../server/service.ts'
import { openCommerce } from '../server/commerce.ts'
import { demoOrders, demoPolicies } from '../server/commerce-fixtures.ts'
import { readTrace } from '../server/trace-store.ts'

test('selecting a specific sold line checks ownership, quantity, policy and receipt, preserving that line on handoff and replay', async t => {
  const store = openStore(':memory:')
  const commerce = openCommerce(store.database)
  const {id} = store.create(id => assert.ok(commerce.login(id, 'A', '1111')))
  const b = store.create(id => assert.ok(commerce.login(id, 'B', '2222')))
  const service = createService(store, async function* () { throw Error('不应调用模型') }, () => {}, commerce)
  t.after(() => {service.shutdown(); commerce.close(); store.close()})
  const order = {...demoOrders[1], id:'SPLIT-101', lines:[
    {line:3,description:'杯子',sku:'CUP',quantity:2,campaign:demoOrders[1].campaign,shipping:'已签收',signedAt:demoOrders[1].signedAt,updatedAt:demoOrders[1].updatedAt},
    {line:7,description:'防滑套',sku:'SLEEVE',quantity:3,campaign:'配件',shipping:'已签收',signedAt:Date.parse('2026-11-17T10:00:00+08:00'),updatedAt:demoOrders[1].updatedAt},
  ]}
  const short = {...demoPolicies[1],id:'SHORT',version:'S1',campaign:'配件',days:5}
  store.database.prepare('INSERT INTO commerce_orders VALUES(?,?,?)').run(order.owner,order.id,JSON.stringify(order))
  store.database.prepare('INSERT INTO commerce_policies VALUES(?,?,?,?,?,?,?)').run(short.id,short.version,short.shop,short.channel,short.campaign,1,JSON.stringify(short))
  const ask = async (target:string,line:number,quantity:number) => {
    assert.ok(service.sendCommerce(target,{action:'return',orderId:order.id,line,quantity,requestId:crypto.randomUUID()}).ok)
    await setImmediate()
    return service.snapshot(target)!.commerce!.latestCard!
  }
  const allowed = await ask(id,3,1)
  assert.deepEqual([allowed.status,allowed.sources[0]?.version,allowed.deadline],['eligible','V2','2026-11-30 23:59:59'])
  const denied = await ask(b.id,7,2)
  assert.deepEqual([denied.status,denied.orderId,denied.selectedLine,denied.facts.length,denied.sources.length],['not_found',undefined,undefined,0,0])
  for (const [line,quantity] of [[3,3],[1,1]]) {
    const invalid = await ask(id,line,quantity)
    assert.equal(invalid.sources.length,0)
    assert.equal(invalid.deadline,null)
    assert.equal(service.snapshot(id)!.mode,'ai')
  }
  const expired = await ask(id,7,2)
  assert.deepEqual([expired.status,expired.sources[0]?.version,expired.deadline],['expired','S1','2026-11-22 23:59:59'])
  assert.deepEqual(expired.selectedLine,{line:7,sku:'SLEEVE',description:'防滑套',quantity:2})
  const evidence = store.database.prepare('SELECT facts FROM commerce_case_evidence WHERE conversation=? AND card=?').get(id,JSON.stringify(expired))
  assert.deepEqual(JSON.parse(String(evidence?.facts)).lines.map((item:{line:number})=>item.line),[7])
  assert.ok(service.sendCustomer(id,{text:'那这件还能退吗？',requestId:'same-line'}).ok)
  await setImmediate()
  assert.equal(service.snapshot(id)!.mode,'ai')
  assert.deepEqual(service.snapshot(id)!.commerce!.latestCard,expired)
  assert.equal(service.requestHandoff(id).ok,true)
  assert.deepEqual(service.listQueue()[0].commerce.latestCard,expired)
  const branch=readTrace(store.database,{q:id,limit:100}).events
  const step=branch.find(e=>e.kind==='eligibility.checked' && e.details.line===7)
  assert.deepEqual([step?.order,step?.details.quantity,step?.details.versions,step?.details.deadline],
    [{orderId:'SPLIT-101',shop:order.shop,owner:'A'},2,'SHORT@S1','2026-11-22 23:59:59'])
  assert.ok(step?.details.causeMessageId)
  const deniedBranch=readTrace(store.database,{q:b.id}).events
  assert.ok(deniedBranch.some(e=>e.kind==='orders.lookup' && e.details.code==='not_found' && e.status==='blocked'))
  assert.ok(deniedBranch.every(e=>!e.order))
  assert.doesNotMatch(JSON.stringify(deniedBranch),/SPLIT-101|SLEEVE|SHORT@S1/)
  assert.ok(!readTrace(store.database,{q:order.id,limit:100}).events.some(e=>e.conversationId===b.id))
})

test('a rejected member login rolls back the new conversation', () => {
  const store = openStore(':memory:')
  try {
    assert.throws(() => store.create(() => { throw new Error('invalid login') }), /invalid login/)
    assert.deepEqual(store.diagnosticCounts(), { ai: 0, waiting: 0, human: 0, resolved: 0 })
  } finally { store.close() }
})

test('a service restart replays the accepted order question, then transfers its exact evidence to staff', async t => {
  const {openCommerce} = await import('../server/commerce.ts')
  const store = openStore(':memory:')
  const commerce = openCommerce(store.database)
  const {id} = store.create(id => assert.equal(commerce.login(id, 'A', '1111'), true))
  store.append(id, 'customer', '这笔订单可以退货吗？', {
    requestId: 'query-1', commerceQuery: {kind: 'return', orderId: 'DEMO-1001'},
  })
  const service = createService(store, async function* () { throw new Error('不应调用模型计算') }, () => {}, commerce)
  t.after(() => {service.shutdown(); commerce.close(); store.close()})
  await setImmediate()
  const card = service.snapshot(id)?.messages.at(-1)?.commerceCard
  assert.equal(card?.status, 'expired')
  assert.equal(card?.orderId, 'DEMO-1001')
  assert.equal(service.snapshot(id)?.commerce?.latestCard?.deadline, card?.deadline)
  assert.equal(service.requestHandoff(id).ok, true)
  assert.deepEqual(service.listQueue()[0].commerce.latestCard, card)
  assert.match(service.listQueue()[0].handoffReason, /顾客/)
  assert.equal(service.claim(id).ok, true)
  assert.deepEqual(service.listQueue()[0].messages.at(-1)?.commerceCard, card)
})

test('a typed follow-up uses the verified order, and an unverified order never reaches the model', async t => {
  const {openCommerce} = await import('../server/commerce.ts')
  const store = openStore(':memory:')
  const commerce = openCommerce(store.database)
  const {id} = store.create(id => assert.equal(commerce.login(id, 'A', '1111'), true))
  const modelInputs: string[] = []
  const service = createService(store, async function* (history) { modelInputs.push(JSON.stringify(history)); yield '你好' }, () => {}, commerce)
  t.after(() => {service.shutdown(); commerce.close(); store.close()})
  service.sendCustomer(id, {text:'查一下 DEMO-1002 的物流', requestId:'typed-1'})
  await setImmediate()
  service.sendCustomer(id, {text:'这单还能退货吗？', requestId:'typed-2'})
  await setImmediate()
  assert.equal(service.snapshot(id)?.commerce?.latestCard?.status, 'eligible')
  service.sendCommerce(id, {action:'order', orderId:'DEMO-2001', requestId:'typed-3'})
  await setImmediate()
  assert.equal(service.snapshot(id)?.commerce?.latestCard?.status, 'not_found')
  assert.equal(service.snapshot(id)?.messages.filter(m => m.commerceCard).length, 3)
  service.sendCommerce(id, {action:'order', orderId:'DEMO-2001', requestId:'typed-3'})
  assert.equal(service.snapshot(id)?.messages.filter(m => m.role === 'customer').length, 3)
  service.sendCustomer(id, {text:'你好', requestId:'ordinary'})
  await setImmediate()
  assert.equal(modelInputs.length, 1)
  assert.doesNotMatch(modelInputs[0], /DEMO-|commerceCard/)
})

test('manual takeover during a second lookup explicitly distinguishes the earlier evidence from the unfinished request', async t => {
  const {openCommerce} = await import('../server/commerce.ts')
  const store = openStore(':memory:')
  const commerce = openCommerce(store.database)
  const {id} = store.create(id => assert.ok(commerce.login(id,'A','1111')))
  const service = createService(store, async function* () {}, () => {}, commerce)
  t.after(() => {service.shutdown(); commerce.close(); store.close()})
  service.sendCommerce(id, {action:'return',orderId:'DEMO-1002',requestId:'first'})
  await setImmediate()
  service.sendCommerce(id, {action:'return',orderId:'DEMO-1004',requestId:'pending'})
  assert.equal(service.requestHandoff(id).ok,true)
  await setImmediate()
  assert.match(service.listQueue()[0].handoffReason, /查询.*未完成/)
  assert.equal(service.listQueue()[0].commerce.latestCard.orderId,'DEMO-1002')
  assert.equal(service.listQueue()[0].messages.filter(m => m.commerceCard).length,1)
})
