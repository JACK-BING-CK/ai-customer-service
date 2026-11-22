import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { createService } from '../server/service.ts'
import { openStore } from '../server/store.ts'
import { readTrace } from '../server/trace-store.ts'

test('resolving removes a ticket from work, and a new customer turn reopens it exactly once', t => {
  const store = openStore(':memory:')
  const {id} = store.create()
  const service = createService(store, async function* () { throw Error('人工会话不应调用模型') }, () => {})
  t.after(() => { service.shutdown(); store.close() })
  service.sendCustomer(id,{text:'转人工',requestId:'ask'})
  service.claim(id)
  service.sendAgent(id,{text:'已核对订单。',requestId:'reply'})
  const version = service.snapshot(id)!.version
  assert.equal(service.resolve(id, version - 1).ok, false)
  assert.equal(service.resolve(id, version).ok, true)
  assert.equal(service.resolve(id, version).ok, true)
  assert.equal(service.snapshot(id)?.mode, 'resolved')
  assert.equal(service.listQueue().length, 0)
  assert.deepEqual(service.listQueue(true).map(s => s.id), [id])
  assert.equal(service.sendAgent(id,{text:'迟到消息',requestId:'late'}).ok, false)
  assert.equal(service.sendCustomer(id,{text:'转人工',requestId:'ask'}).ok, true)
  assert.equal(service.snapshot(id)?.mode, 'resolved')
  const followup = {text:'到底哪天截止？',requestId:'followup'}
  assert.equal(service.sendCustomer(id,followup).ok, true)
  assert.equal(service.sendCustomer(id,followup).ok, true)
  assert.equal(service.snapshot(id)?.mode, 'waiting')
  assert.deepEqual(service.listQueue()[0].messages.map(m=>m.text), ['转人工','已核对订单。','到底哪天截止？'])
  assert.equal(service.listQueue(true).length, 0)
  assert.deepEqual(store.diagnosticSession(id)?.lifecycle.map(e => e.kind), ['resolved','reopened'])
  service.claim(id)
  assert.equal(service.resolve(id,version).ok, false)
  assert.deepEqual(readTrace(store.database,{q:id}).events.sort((a,b)=>a.sequence-b.sequence).map(e=>e.kind),[
    'session.created','customer.message','handoff.waiting','agent.claimed','agent.reply','session.resolved',
    'customer.message','session.reopened','agent.claimed',
  ])
})

test('timeout, notification and transfer have separate durable steps for one question and no raw text', async t => {
  const store=openStore(':memory:')
  const {id,token}=store.create()
  const service=createService(store,async function*(){throw new DOMException('private endpoint detail','TimeoutError')},()=>{})
  t.after(()=>{service.shutdown();store.close()})
  const input={text:'私人咨询原文',requestId:'用户自由填写请求编号'}
  assert.ok(service.sendCustomer(id,input).ok)
  await setImmediate()
  assert.ok(service.sendCustomer(id,input).ok)
  const events=readTrace(store.database,{q:id}).events.sort((a,b)=>a.sequence-b.sequence)
  assert.deepEqual(events.map(e=>e.kind),['session.created','customer.message','ai.started','ai.failed','system.message','handoff.waiting'])
  assert.equal(new Set(events.map(e=>e.id)).size,events.length)
  const question=service.snapshot(id)!.messages[0].id
  assert.equal(events[1].details.messageId,question)
  for(const e of events.slice(2,5)) assert.equal(e.details.causeMessageId,question)
  assert.deepEqual([events[3].status,events[3].details.code],['error','timeout'])
  assert.doesNotMatch(JSON.stringify(events),/私人咨询原文|用户自由填写请求编号|private endpoint detail/)
  assert.ok(!JSON.stringify(events).includes(token))
})

test('customer can close a completed AI answer just once; pending and stale confirmations cannot close newer turns', async t=>{
  const store=openStore(':memory:')
  const {id}=store.create()
  let finish=()=>{}
  const pending=new Promise<void>(resolve=>{finish=resolve})
  const service=createService(store,async function*(messages){
    if(messages.filter(m=>m.role==='customer').length===2){yield '部分答复';await pending}
    yield '完整答复'
  },()=>{})
  t.after(()=>{service.shutdown();store.close()})
  assert.equal(service.resolve(id,service.snapshot(id)!.version,'customer').ok,false)
  service.sendCustomer(id,{text:'第一个问题',requestId:'one'})
  await setImmediate()
  const previous=service.snapshot(id)!.version
  service.sendCustomer(id,{text:'第二个问题',requestId:'two'})
  await setImmediate()
  assert.equal(service.snapshot(id)!.generating,true)
  assert.equal(service.resolve(id,service.snapshot(id)!.version,'customer').ok,false)
  finish()
  await setImmediate()
  const delivered=service.snapshot(id)!
  assert.equal(service.resolve(id,previous,'customer').ok,false)
  assert.equal(service.resolve(id,delivered.version,'customer').ok,true)
  assert.equal(service.resolve(id,delivered.version,'customer').ok,true)
  assert.equal(service.listQueue().length,0)
  assert.equal(service.listQueue(true)[0].mode,'resolved')
  assert.equal(store.diagnosticSession(id)?.lifecycle[0].by,'customer')
  const steps=readTrace(store.database,{q:id}).events
  assert.equal(steps.filter(e=>e.kind==='customer.resolved').length,1)
  assert.equal(steps.at(-1)?.details.messageId,delivered.messages.at(-1)!.id)
  assert.ok(!steps.some(e=>e.kind==='agent.claimed' || e.kind==='session.resolved'))
  assert.ok(service.sendCustomer(id,{text:'我还有疑问',requestId:'three'}).ok)
  assert.equal(service.snapshot(id)!.mode,'waiting')
  assert.equal(service.resolve(id,delivered.version,'customer').ok,false)
})

test('streams a draft, commits the reply, and treats repeated request IDs as one message', async (t) => {
  const store = openStore(':memory:')
  const { id } = store.create()
  let settle = () => {}
  const finish = new Promise<void>((resolve) => { settle = resolve })
  const service = createService(store, async function* () {
    yield '你'
    await finish
    yield '好'
  }, () => {})
  t.after(() => { service.shutdown(); store.close() })

  assert.deepEqual(service.sendCustomer(id, { text: '问候', requestId: 'first' }), { ok: true })
  await setImmediate()
  const draft = service.snapshot(id)
  assert.equal(draft?.generating, true)
  assert.equal(draft?.draft, '你')

  assert.deepEqual(service.sendCustomer(id, { text: '问候', requestId: 'first' }), { ok: true })
  assert.equal(service.sendCustomer(id, { text: '另一条', requestId: 'first' }).ok, false)
  settle()
  await setImmediate()
  const complete = service.snapshot(id)
  assert.equal(complete?.generating, false)
  assert.ok(complete && draft && complete.version > draft.version)
  assert.deepEqual(complete?.messages.map(({ role, text }) => [role, text]), [
    ['customer', '问候'],
    ['assistant', '你好'],
  ])
  assert.deepEqual(readTrace(store.database,{q:id}).events.sort((a,b)=>a.sequence-b.sequence).map(e=>e.kind),
    ['session.created','customer.message','ai.started','ai.completed'])
})

test('explicit requests for a human cancel streaming and late chunks cannot enter the transcript', async (t) => {
  const store = openStore(':memory:')
  const { id } = store.create()
  let settle = () => {}
  const finish = new Promise<void>((resolve) => { settle = resolve })
  let signal: AbortSignal | undefined
  const service = createService(store, async function* (_messages, abortSignal) {
    signal = abortSignal
    yield '未完成'
    await finish
    yield '不应发送'
  }, () => {})
  t.after(() => { service.shutdown(); store.close() })

  service.sendCustomer(id, { text: '退款政策是什么？', requestId: 'first' })
  await setImmediate()
  assert.equal(service.snapshot(id)?.draft, '未完成')
  assert.deepEqual(service.sendCustomer(id, { text: '麻烦帮我转人工客服，谢谢！', requestId: 'second' }), { ok: true })
  assert.equal(signal?.aborted, true)
  assert.equal(service.snapshot(id)?.mode, 'waiting')
  assert.equal(service.snapshot(id)?.draft, '')
  assert.equal(service.sendAgent(id, { text: '提前回复', requestId: 'agent-before' }).ok, false)
  assert.deepEqual(service.claim(id), { ok: true })
  assert.deepEqual(service.sendAgent(id, { text: '我来帮您处理。', requestId: 'agent-after' }), { ok: true })
  settle()
  await setImmediate()
  assert.equal(service.snapshot(id)?.mode, 'human')
  assert.deepEqual(service.snapshot(id)?.messages.filter(({ role }) => role === 'assistant'), [])
  assert.deepEqual(service.snapshot(id)?.messages.filter(({ role }) => role === 'agent').map(({ text }) => text), ['我来帮您处理。'])
  const trace=readTrace(store.database,{q:id}).events
  assert.ok(trace.some(e=>e.kind==='ai.cancelled' && e.details.code==='human_handoff'))
  assert.ok(!trace.some(e=>e.kind==='ai.completed' || e.kind==='ai.failed'))
})

test('short human requests route to staff while a negated request remains automated', (t) => {
  const store = openStore(':memory:')
  const service = createService(store, async function* () { yield '自动回复' }, () => {})
  t.after(() => { service.shutdown(); store.close() })
  const examples = [
    ['转一下人工', 'waiting'],
    ['我想和真人客服聊聊', 'waiting'],
    ['不需要转人工', 'ai'],
    ['你是否支持人工服务？', 'ai'],
  ] as const
  for (const [text, expected] of examples) {
    const { id } = store.create()
    assert.equal(service.sendCustomer(id, { text, requestId: 'first' }).ok, true)
    assert.equal(service.snapshot(id)?.mode, expected, text)
  }
})

test('a newer customer turn replaces the old generation and includes both customer messages', async (t) => {
  const store = openStore(':memory:')
  const { id } = store.create()
  let releaseOld = () => {}
  const old = new Promise<void>((resolve) => { releaseOld = resolve })
  let firstSignal: AbortSignal | undefined
  const service = createService(store, async function* (messages, signal) {
    if (messages.length === 1) {
      firstSignal = signal
      await old
      yield '过时回复'
      return
    }
    yield messages.map((message) => message.text).join('、')
  }, () => {})
  t.after(() => { service.shutdown(); store.close() })

  service.sendCustomer(id, { text: '问题一', requestId: 'first' })
  await setImmediate()
  service.sendCustomer(id, { text: '问题二', requestId: 'second' })
  await setImmediate()
  assert.equal(firstSignal?.aborted, true)
  releaseOld()
  await setImmediate()
  assert.deepEqual(service.snapshot(id)?.messages.filter(({ role }) => role === 'assistant').map(({ text }) => text), ['问题一、问题二'])
})

test('a failed model routes the conversation to the queue without exposing its error', async (t) => {
  const store = openStore(':memory:')
  const { id } = store.create()
  const logged = t.mock.method(console, 'log', () => {})
  const service = createService(store, async function* () {
    throw Object.assign(new Error('private backend message'), {
      statusCode: 429,
      responseBody: 'private backend body',
      url: 'https://example.invalid/private',
    })
  }, () => {})
  t.after(() => { service.shutdown(); store.close() })
  service.sendCustomer(id, { text: '咨询', requestId: 'first' })
  await setImmediate()
  const snapshot = service.snapshot(id)
  assert.equal(snapshot?.mode, 'waiting')
  assert.equal(snapshot?.generating, false)
  assert.equal(snapshot?.messages.some(({ role }) => role === 'system'), true)
  assert.equal(JSON.stringify(snapshot).includes('private backend message'), false)
  const lines = logged.mock.calls.map((call) => String(call.arguments[0]))
  const failures = lines.map((line) => JSON.parse(line)).filter((entry) => entry.event === 'generation_failed')
  assert.deepEqual(failures.map((entry) => [entry.conversationId, entry.kind, entry.statusCode]), [[id, 'provider_http', 429]])
  assert.doesNotMatch(lines.join('\n'), /private backend|example\.invalid/)
})

test('startup resumes an accepted customer turn that never received a reply', async (t) => {
  const store = openStore(':memory:')
  const { id } = store.create()
  store.append(id, 'customer', '未答复', { requestId: 'first' })
  const service = createService(store, async function* (messages) {
    yield messages.at(-1)?.text === '未答复' ? '恢复的答复' : '错误'
  }, () => {})
  t.after(() => { service.shutdown(); store.close() })
  await setImmediate()
  assert.equal(service.snapshot(id)?.messages.at(-1)?.text, '恢复的答复')
})
