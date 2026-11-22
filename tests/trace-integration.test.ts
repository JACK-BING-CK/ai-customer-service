import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {once} from 'node:events'
import {test} from 'node:test'
import express from 'express'
import {openStore} from '../server/store.ts'
import {openCommerce} from '../server/commerce.ts'
import {openMerchant} from '../server/merchant-store.ts'
import {openFeedback} from '../server/feedback-store.ts'
import {importTraceHistory} from '../server/trace-history.ts'
import {readTrace} from '../server/trace-store.ts'
import {traceRoutes} from '../server/trace-routes.ts'
import {demoCheckoutRoutes} from '../server/demo-checkout.ts'

test('checkout receipt write failure rolls back the order and its success event; retry commits exactly once',async t=>{
  const store=openStore(':memory:')
  const db=store.database
  const commerce=openCommerce(db)
  const merchant=openMerchant(db)
  const session=store.create(id=>assert.ok(commerce.login(id,'A','1111')))
  const notifications:string[]=[]
  const app=express()
  app.use('/:conversationId',demoCheckoutRoutes(store,merchant,id=>notifications.push(id)))
  const server=app.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));store.close()})
  const addr=server.address()
  assert.ok(addr && typeof addr==='object')
  const url='http://127.0.0.1:'+addr.port+'/'+session.id
  const headers={Authorization:'Bearer '+session.token,'Content-Type':'application/json'}
  const {products}=await (await fetch(url,{headers})).json()
  const body=JSON.stringify({sku:products[0].sku,quantity:1,requestId:randomUUID()})
  const submit=()=>fetch(url,{method:'POST',headers,body})
  db.exec("CREATE TEMP TRIGGER simulate_receipt_fault BEFORE INSERT ON demo_checkout_requests BEGIN SELECT RAISE(ABORT,'receipt fault'); END")
  const failed=await submit()
  assert.equal(failed.status,500)
  const {stepId}=await failed.json()
  assert.equal((await (await submit()).json()).stepId,stepId)
  const failure=readTrace(db,{q:stepId}).selectedEvent
  assert.deepEqual([failure?.kind,failure?.status,failure?.order,failure?.details],
    ['checkout.failed','error',null,{source:'checkout',code:'checkout_error'}])
  assert.equal(db.prepare("SELECT count(*) AS n FROM commerce_orders WHERE id LIKE 'SIM-%'").get()?.n,0)
  assert.ok(!readTrace(db,{q:session.id}).events.some(e=>e.kind==='order.placed'))
  assert.deepEqual(notifications,[])
  db.exec('DROP TRIGGER simulate_receipt_fault')
  const retries=await Promise.all([submit(),submit()])
  assert.deepEqual(retries.map(r=>r.status).sort(),[200,201])
  const receipts=await Promise.all(retries.map(r=>r.json()))
  assert.deepEqual(receipts[0],receipts[1])
  const events=readTrace(db,{q:session.id}).events
  assert.deepEqual(events.filter(e=>['checkout.failed','order.placed'].includes(e.kind)).map(e=>e.kind),['checkout.failed','order.placed'])
  assert.deepEqual(notifications,[session.id])
})

test('legacy history uses saved evidence, keeps IDs across reinitialization, and original messages require staff access',async t=>{
  const store=openStore(':memory:')
  const db=store.database
  openCommerce(db);openFeedback(db,openMerchant(db))
  const id=randomUUID(), messageId=randomUUID(), cardId=randomUUID()
  db.prepare('INSERT INTO conversations(id,token_hash,created_at,updated_at) VALUES(?,?,?,?)').run(id,Buffer.alloc(32),1000,2000)
  db.prepare('INSERT INTO messages(id,conversation_id,role,text,at) VALUES(?,?,?,?,?)').run(messageId,id,'assistant','测试时留存的原回复',2000)
  const card={kind:'return',status:'eligible',sources:[{id:'RETURN',version:'V1',title:'原条款',text:'原条款正文'}],deadline:'2026-11-23 23:59:59'}
  db.prepare('INSERT INTO messages(id,conversation_id,role,text,at,commerce_card) VALUES(?,?,?,?,?,?)').run(cardId,id,'assistant','旧判断卡',2001,JSON.stringify(card))
  importTraceHistory(db)
  const prior=readTrace(db,{q:id})
  assert.equal(prior.legacy,true)
  assert.deepEqual(prior.events.map(e=>e.kind),['session.created','ai.completed','commerce.reply'])
  assert.equal(prior.events[2].details.versions,'RETURN@V1')
  assert.equal(prior.events[2].details.deadline,card.deadline)
  assert.ok(prior.events.every(e=>e.details.source==='history'))
  importTraceHistory(db)
  assert.deepEqual(readTrace(db,{q:id}),prior)
  const app=express()
  app.use('/api/debug/trace',traceRoutes(db,'test-staff'))
  const server=app.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));store.close()})
  const addr=server.address()
  assert.ok(addr && typeof addr==='object')
  const base='http://127.0.0.1:'+addr.port+'/api/debug/trace'
  const path=base+'/'+prior.events[1].id+'/message'
  const headers={Authorization:'Bearer test-staff'}
  assert.equal((await fetch(path)).status,401)
  assert.equal((await fetch(base+'?q='+id)).status,401)
  assert.equal((await fetch(base+'?cursor=-1',{headers})).status,400)
  assert.equal((await fetch(base+'?q='+'x'.repeat(161),{headers})).status,400)
  const trace=await (await fetch(base+'?q='+id,{headers})).text()
  assert.doesNotMatch(trace,/测试时留存的原回复|原条款正文|test-staff/)
  const original=await (await fetch(path,{headers})).json()
  assert.equal(original.text,'测试时留存的原回复')
  assert.equal(original.id,messageId)
  assert.equal((await fetch(base+'/'+prior.events[0].id+'/message',{headers})).status,404)
})

test('preview and rejected Excel batches leave no phantom orders or duplicate source events',()=>{
  const store=openStore(':memory:')
  try {
    const db=store.database;openCommerce(db)
    const merchant=openMerchant(db)
    const product={'商品编码（SKU）':'X1',商品名称:'箱',规格或型号:'小',商品类别:'收纳',已确认的商品事实:'模拟',事实来源:'模拟'}
    const order={订单号:'BUY-TEST',行号:'1',店铺会员编号:'A',成交商品编码:'X1',成交商品与规格:'箱 · 小',购买数量:'2',店铺:'测试店',成交渠道:'测试网页',成交活动:'常规',下单时间:'2026-11-16 12:00:00',物流状态:'待发货',签收时间:'',物流更新时间:'2026-11-16 12:00:00'}
    const rows={products:[product],orders:[order]}
    const excel={source:'excel' as const}
    assert.ok(merchant.apply(rows,false,undefined,excel).ok)
    assert.equal(readTrace(db,{q:order.订单号}).matched,false)
    assert.equal(merchant.apply({...rows,orders:[order,{...order,行号:'2',成交商品编码:'NO-SKU'}]},true,undefined,excel).ok,false)
    assert.equal(readTrace(db,{q:order.订单号}).matched,false)
    assert.ok(merchant.apply(rows,true,undefined,excel).ok)
    assert.ok(merchant.apply(rows,true,undefined,excel).ok)
    assert.ok(merchant.apply({orders:[{...order,物流状态:'运输中',物流更新时间:'2026-11-17 01:00:00'}]},true).ok)
    const records=readTrace(db,{q:order.订单号}).events
    assert.deepEqual(records.map(e=>[e.kind,e.details.source]),[['order.imported','excel'],['order.updated','manual']])
  }finally{store.close()}
})
