import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtempSync, unlinkSync, rmdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {test} from 'node:test'
import {appendTrace,initTraceStore,readTrace} from '../server/trace-store.ts'

const order={shop:'山溪店',owner:'A',orderId:'ORD-101'}
test('stable immutable IDs, atomic writes, safe fields and chronological pagination after restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'support-traces-')), file=join(dir,'store.sqlite')
  let db=new DatabaseSync(file)
  try {
    const conversationId=randomUUID(), input={kind:'session.created' as const,conversationId,dedupeKey:'creation',at:20}
    initTraceStore(db)
    db.exec('BEGIN')
    appendTrace(db,input)
    db.exec('ROLLBACK')
    assert.equal(readTrace(db,{q:conversationId}).matched,false)
    const created=appendTrace(db,input)
    assert.match(created,/^EV-[0-9a-f-]{36}$/)
    assert.equal(appendTrace(db,input),created)
    assert.throws(()=>db.prepare('UPDATE support_trace SET at=1 WHERE event_id=?').run(created),/immutable/)
    assert.throws(()=>db.prepare('DELETE FROM support_trace WHERE event_id=?').run(created),/immutable/)
    const first=appendTrace(db,{kind:'order.imported',order,at:3,details:{orderedAt:2,source:'excel',token:'do-not-save'}})
    appendTrace(db,{kind:'orders.lookup',conversationId,order,at:20,details:{code:'found',text:'PRIVATE MESSAGE',quantity:2}})
    const last=appendTrace(db,{kind:'agent.reply',conversationId,at:21})
    // The historical row arrives late and still belongs at its own business time.
    appendTrace(db,{kind:'customer.message',conversationId,at:10,details:{source:'history'}})
    db.close()
    db=new DatabaseSync(file)
    const p1=readTrace(db,{q:last,limit:2})
    assert.equal(p1.selectedEvent?.id,last)
    assert.equal(p1.legacy,true)
    assert.deepEqual(p1.events.map(e=>e.kind),['order.imported','customer.message'])
    const p2=readTrace(db,{q:'TR-'+conversationId,cursor:p1.nextCursor!,limit:2})
    const p3=readTrace(db,{q:conversationId.slice(-6),cursor:p2.nextCursor!,limit:2})
    assert.deepEqual(p2.events.map(e=>e.kind),['session.created','orders.lookup'])
    assert.deepEqual(p3.events.map(e=>e.id),[last])
    assert.equal(p3.nextCursor,null)
    assert.ok(p2.events.every(e=>e.flowId==='TR-'+conversationId))
    assert.doesNotMatch(JSON.stringify(readTrace(db,{q:'ord-101'})),/do-not-save|PRIVATE MESSAGE/)
    const recent=readTrace(db,{limit:3})
    assert.equal(recent.events[0].id,last)
    assert.equal(readTrace(db,{cursor:recent.nextCursor!}).events.at(-1)?.id,first)
  } finally {db.close();unlinkSync(file);rmdirSync(dir)}
})

test('order origin and verified consultations branch by store and owner without following unverified guesses',()=>{
  const db=new DatabaseSync(':memory:')
  try {
    const buyer=randomUUID(), later=randomUUID(), outsider=randomUUID(), sameNumber=randomUUID()
    const source=appendTrace(db,{kind:'order.placed',conversationId:buyer,order})
    appendTrace(db,{kind:'session.resolved',conversationId:buyer})
    appendTrace(db,{kind:'orders.lookup',conversationId:later,order,details:{code:'found'}})
    const foreign=appendTrace(db,{kind:'orders.lookup',conversationId:outsider,order,status:'blocked',details:{code:'not_found'}})
    const other={...order,shop:'第二家店',owner:'B'}
    appendTrace(db,{kind:'order.recorded',order:other})
    appendTrace(db,{kind:'orders.lookup',conversationId:sameNumber,order:other,details:{code:'found'}})
    const byOrigin=readTrace(db,{q:source})
    assert.deepEqual(new Set(byOrigin.events.map(e=>e.conversationId)),new Set([buyer,later]))
    assert.equal(byOrigin.selectedEvent?.id,source)
    assert.deepEqual(readTrace(db,{q:later}).events.map(e=>e.kind),['order.placed','orders.lookup'])
    const search=readTrace(db,{q:order.orderId})
    assert.equal(search.events.some(e=>e.id===foreign),false)
    assert.deepEqual(new Set(search.events.flatMap(e=>e.order?[e.order.shop]:[])),new Set([order.shop,other.shop]))
    assert.deepEqual(readTrace(db,{q:foreign}).events.map(e=>e.id),[foreign])
  } finally {db.close()}
})

test('recognizes older conversations without inventing unrecorded steps',()=>{
  const db=new DatabaseSync(':memory:')
  try {
    const conversationId=randomUUID()
    db.exec('CREATE TABLE conversations(id TEXT PRIMARY KEY,created_at INTEGER)')
    db.prepare('INSERT INTO conversations VALUES(?,1)').run(conversationId)
    const result=readTrace(db,{q:'TR-'+conversationId})
    assert.equal(result.legacy,true)
    assert.equal(result.matched,true)
    assert.deepEqual(result.events,[])
    assert.equal(readTrace(db,{q:randomUUID()}).matched,false)
  } finally {db.close()}
})
