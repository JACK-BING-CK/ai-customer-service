import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test, type TestContext } from 'node:test'
import { io, type Socket } from 'socket.io-client'
import type { Session, Snapshot } from '../shared/protocol.ts'
import type { DiagnosticReport, DiagnosticSession } from '../shared/diagnostics.ts'

const agentKey = 'fixture-monitor-staff-key'

async function startFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'support-monitor-test-'))
  const child = spawn(process.execPath, ['server/main.ts'], {
    env: { ...process.env, PORT: '0', SUPPORT_DATA_DIR: directory, SUPPORT_AGENT_KEY: agentKey, DEEPSEEK_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  const sockets: Socket[] = []
  t.after(async () => {
    for (const socket of sockets) socket.disconnect()
    child.kill()
    await exited
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  })

  const lines = createInterface({ input: child.stdout })
  for await (const line of lines) {
    const event = JSON.parse(line)
    if (event.event !== 'ready') continue
    const url: string = event.url
    return {
      url,
      async session(): Promise<Session> {
        const response = await fetch(`${url}/api/conversations`, { method: 'POST' })
        assert.equal(response.status, 201)
        return response.json() as Promise<Session>
      },
      async connect(auth: Record<string, string>, events?: string[]): Promise<Socket> {
        const socket = io(url, { auth, autoConnect: false, reconnection: false, forceNew: true })
        sockets.push(socket)
        if (events) socket.onAny(event => events.push(event))
        const initial: Record<string, string> = { customer: 'snapshot', agent: 'queue', debug: 'diagnostics:ready' }
        const ready = new Promise<void>((resolve, reject) => {
          socket.once('connect_error', reject)
          socket.once(initial[auth.role], () => {
            socket.off('connect_error', reject)
            resolve()
          })
        })
        socket.connect()
        await ready
        return socket
      },
    }
  }
  throw Error('Monitor test service exited before becoming ready')
}

function call(socket: Socket, event: string, payload: object) {
  return socket.timeout(2000).emitWithAck(event, payload)
}

test('a separate read-only debugger can inspect routing without chat content, customer access or staff permissions', { timeout: 15000 }, async t => {
  const fixture = await startFixture(t)
  const first = await fixture.session()
  const other = await fixture.session()
  const customerEvents: string[] = []
  const agentEvents: string[] = []
  const debugEvents: string[] = []
  await assert.rejects(fixture.connect({ role: 'debug', token: 'wrong-fixture-key' }), /unauthorized/i)
  const customer = await fixture.connect({ role: 'customer', ...first }, customerEvents)
  const agent = await fixture.connect({ role: 'agent', token: agentKey }, agentEvents)
  const inspector = await fixture.connect({ role: 'debug', token: agentKey }, debugEvents)

  const initial = await call(inspector, 'debug:read', { id: first.id })
  const connections = initial.report.evidence.connections
  assert.equal(connections.customers, 1)
  assert.equal(connections.agents, 1)
  assert.equal(connections.selectedCustomerViews, 0)
  assert.equal(connections.selectedAgentViews, 0)
  const product = { '商品编码（SKU）':'PRIVATE-SKU', 商品名称:'PRIVATE-PRODUCT', 规格或型号:'小号', 商品类别:'旅行杯',
    已确认的商品事实:'便携规格', 事实来源:'PRIVATE-SOURCE' }
  const save = await fetch(fixture.url + '/api/merchant/save', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({kind:'products',row:product})})
  assert.equal(save.status, 200)
  const shopReport: DiagnosticReport = (await call(inspector, 'debug:read', {id:first.id})).report
  const shop = shopReport.modules.find(module => module.id === 'merchant')
  assert.equal(shop?.status, '已保存资料')
  assert.match(shop.detail, /商品资料/)
  assert.ok(shop.at)
  assert.equal(shopReport.selected?.events.some(event => event.module === 'merchant'), false)
  assert.ok(!JSON.stringify(shopReport).includes('PRIVATE-'))
  customer.emit('client:view', { id: first.id })
  for (const restricted of [customer, agent]) {
    const denied = await call(restricted, 'debug:read', { id: other.id })
    assert.equal(denied.ok, false)
    assert.equal(denied.report, undefined)
    assert.ok(!JSON.stringify(denied).includes(other.id))
  }
  const displayed = await call(inspector, 'debug:read', { id: first.id })
  assert.equal(displayed.report.evidence.connections.selectedCustomerViews, 1)
  assert.equal(displayed.report.evidence.connections.selectedAgentViews, 0)

  const privateQuestion = 'fixture-private-customer-question'
  const staffReply = 'fixture-private-agent-reply'
  async function inspect(id: string, search?: string): Promise<DiagnosticSession> {
    const ack = await call(inspector, 'debug:read', { id, search })
    assert.equal(ack.ok, true)
    const report: DiagnosticReport = ack.report
    const json = JSON.stringify(report)
    for (const secret of [first.token, other.token, agentKey, privateQuestion, staffReply]) {
      assert.ok(!json.includes(secret), 'diagnostics must contain metadata only')
    }
    assert.equal(report.modules.find(module => module.id === 'storage')?.state, 'ok')
    assert.equal(report.modules.find(module => module.id === 'ai')?.state, 'error')
    assert.ok(report.selected)
    assert.equal(report.selected.id, id)
    assert.ok(report.sessions.some(session => session.id === id))
    if (search) assert.ok(report.sessions.every(session => session.id.endsWith(search.toLowerCase())))
    return report.selected
  }

  const ai = await inspect(first.id, first.id.slice(-6).toUpperCase())
  assert.equal(ai.mode, 'ai')
  assert.equal(ai.stages.find(stage => stage.id === 'agent')?.state, 'pending')
  const monitorChanged = once(inspector, 'diagnostics:changed')
  const waiting = new Promise<void>(resolve => {
    function observe(snapshot: Snapshot) {
      if (snapshot.mode !== 'waiting') return
      customer.off('snapshot', observe)
      resolve()
    }
    customer.on('snapshot', observe)
  })
  assert.equal((await call(customer, 'customer:send', { text: privateQuestion, requestId: 'first-message' })).ok, true)
  await Promise.all([waiting, monitorChanged])
  const failed = await inspect(first.id)
  assert.equal(failed.mode, 'waiting')
  assert.equal(failed.stages.find(stage => stage.id === 'ai')?.state, 'failed')
  assert.ok(failed.events.some(event => event.event === 'generation_failed' && event.failed))
  assert.ok(failed.events.some(event => event.event === 'customer_message' && event.module === 'storage'))

  assert.equal((await call(inspector, 'agent:claim', { id: first.id })).ok, false)
  assert.equal((await call(agent, 'agent:claim', { id: first.id })).ok, true)
  const claimed = await inspect(first.id)
  assert.equal(claimed.stages.find(stage => stage.id === 'agent')?.state, 'done')
  assert.equal(claimed.stages.find(stage => stage.id === 'reply')?.state, 'active')
  assert.equal((await call(inspector, 'agent:send', { id: first.id, text: staffReply, requestId: 'debug-reply' })).ok, false)
  assert.equal((await call(agent, 'agent:send', { id: first.id, text: staffReply, requestId: 'staff-message' })).ok, true)
  const handled = await inspect(first.id)
  assert.equal(handled.mode, 'human')
  assert.equal(handled.stages.find(stage => stage.id === 'reply')?.state, 'done')
  assert.ok(handled.events.some(event => event.event === 'agent_message' && event.stage === 'reply'))
  assert.ok(handled.events.some(event => event.event === 'mode_changed' && event.stage === 'agent'))
  const direct = await fixture.connect({ role: 'customer', ...other })
  assert.equal((await call(direct, 'customer:handoff', {})).ok, true)
  const bypass = await inspect(other.id)
  assert.equal(bypass.mode, 'waiting')
  assert.equal(bypass.stages.find(stage => stage.id === 'ai')?.state, 'skipped')
  assert.ok(!bypass.events.some(event => event.module === 'ai' || event.event === 'agent_message'))
  assert.ok(!customerEvents.some(event => event.includes('diagnostic') || event === 'queue'))
  assert.ok(!agentEvents.some(event => event.includes('diagnostic') || event === 'snapshot'))
  assert.ok(!debugEvents.some(event => event === 'queue' || event === 'snapshot'))
})
