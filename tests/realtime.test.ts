import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test, type TestContext } from 'node:test'
import { Server } from 'socket.io'
import { io as createClient, type Socket } from 'socket.io-client'
import type { Snapshot } from '../shared/protocol.ts'
import { bindRealtime } from '../server/realtime.ts'
import { createService } from '../server/service.ts'
import { openStore } from '../server/store.ts'

test('a local agent without a key can receive the queue, claim and reply', { timeout: 8000 }, t => exerciseHandoff(t))

test('configured agent credentials protect the queue while customer permissions stay scoped', { timeout: 8000 }, t => exerciseHandoff(t, 'staff-secret'))

async function exerciseHandoff(t: TestContext, agentKey?: string) {
  const store = openStore(':memory:')
  const first = store.create()
  const second = store.create()
  const http = createServer()
  const io = new Server(http)
  let publish: (id: string) => void = () => {}
  const service = createService(store, async function* () { yield '自动回复' }, (id) => publish(id))
  publish = bindRealtime(io, service, store, agentKey)
  const ready = once(http, 'listening')
  http.listen(0, '127.0.0.1')
  await ready
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Expected a local test port')
  const clients: Socket[] = []
  t.after(async () => {
    for (const client of clients) client.disconnect()
    await io.close()
    service.shutdown()
    store.close()
  })
  function client(auth: Record<string, string | boolean>) {
    const socket = createClient(`http://127.0.0.1:${address.port}`, { auth, autoConnect: false, reconnection: false })
    clients.push(socket)
    return socket
  }
  async function expectDenied(auth: Record<string, string>) {
    const denied = client(auth)
    const rejected = new Promise<Error & { data?: {code?: string} }>(resolve => denied.once('connect_error', resolve))
    denied.connect()
    assert.equal((await rejected).data?.code, 'UNAUTHORIZED')
    assert.equal(denied.connected, false)
  }
  await expectDenied({ role: 'customer', id: first.id, token: second.token })
  await expectDenied({ role: 'customer', id: first.id })
  if (agentKey) {
    await expectDenied({ role: 'agent' })
    await expectDenied({ role: 'agent', token: 'wrong-key' })
  }

  const customer = client({ role: 'customer', ...first })
  const customerInitial = once(customer, 'snapshot')
  customer.connect()
  assert.equal((await customerInitial)[0].id, first.id)
  const agent = client(agentKey ? { role: 'agent', token: agentKey } : { role: 'agent' })
  const initialQueue = once(agent, 'queue')
  agent.connect()
  assert.deepEqual((await initialQueue)[0], [])
  const denied = await customer.timeout(1000).emitWithAck('agent:claim', { id: second.id })
  assert.equal(denied.ok, false)

  const waitingQueue = once(agent, 'queue')
  assert.deepEqual(await customer.timeout(1000).emitWithAck('customer:handoff', {}), { ok: true })
  assert.deepEqual((await waitingQueue)[0].map(({ id, mode }: Snapshot) => [id, mode]), [[first.id, 'waiting']])
  customer.disconnect()
  assert.deepEqual(await agent.timeout(1000).emitWithAck('agent:claim', { id: first.id }), { ok: true })
  assert.deepEqual(await agent.timeout(1000).emitWithAck('agent:send', { id: first.id, text: '人工消息', requestId: 'staff-1' }), { ok: true })
  const reconnected = client({ role: 'customer', ...first })
  const recoveredSnapshot = once(reconnected, 'snapshot')
  reconnected.connect()
  const [snapshot] = await recoveredSnapshot
  assert.equal(snapshot.id, first.id)
  assert.equal(snapshot.mode, 'human')
  assert.equal(snapshot.messages.at(-1).text, '人工消息')
  assert.equal(store.snapshot(second.id)?.messages.length, 0)
  const closePayload = {id:first.id,version:snapshot.version}
  assert.equal((await reconnected.timeout(1000).emitWithAck('agent:resolve',closePayload)).ok,false)
  const removed = once(agent,'queue')
  const customerClosed = once(reconnected,'snapshot')
  assert.equal((await agent.timeout(1000).emitWithAck('agent:resolve',closePayload)).ok,true)
  assert.deepEqual((await removed)[0],[])
  assert.equal((await customerClosed)[0].mode,'resolved')
  const archive = client({role:'agent',token:agentKey ?? '',archive:true})
  const closedHistory = once(archive,'queue')
  archive.connect()
  const [archived] = await closedHistory
  assert.equal(archived[0].id,first.id)
  assert.equal(archived[0].messages.at(-1).text,'人工消息')
  const restored = once(agent,'queue')
  const removedFromArchive = once(archive,'queue')
  assert.equal((await reconnected.timeout(1000).emitWithAck('customer:send',{text:'还有后续问题',requestId:'followup'})).ok,true)
  const [pending] = await restored
  assert.equal(pending[0].id,first.id)
  assert.equal(pending[0].mode,'waiting')
  assert.deepEqual((await removedFromArchive)[0],[])
  const selfServe=client({role:'customer',...second})
  const started=once(selfServe,'snapshot')
  selfServe.connect()
  await started
  const answered=new Promise<Snapshot>(resolve=>{
    const onSnapshot=(s:Snapshot)=>{if(s.messages.at(-1)?.role==='assistant'){selfServe.off('snapshot',onSnapshot);resolve(s)}}
    selfServe.on('snapshot',onSnapshot)
  })
  assert.ok((await selfServe.timeout(1000).emitWithAck('customer:send',{text:'你好',requestId:'hello'})).ok)
  const response=await answered
  const completed=once(selfServe,'snapshot')
  const confirm={version:response.version}
  assert.ok((await selfServe.timeout(1000).emitWithAck('customer:resolve',confirm)).ok)
  assert.equal((await completed)[0].mode,'resolved')
  assert.ok((await selfServe.timeout(1000).emitWithAck('customer:resolve',confirm)).ok)
  assert.equal(store.diagnosticSession(second.id)?.lifecycle.length,1)
  assert.equal(store.snapshot(first.id)?.mode,'waiting')
}
