import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { io } from 'socket.io-client'

// A real server, a fresh database and the same four public entry points used by the web clients.
const data = await mkdtemp(join(tmpdir(), 'support-orders-'))
const server = spawn(process.execPath, ['server/main.ts'], {
  env: { ...process.env, PORT:'0', SUPPORT_DATA_DIR:data, SUPPORT_AGENT_KEY:'', DEEPSEEK_API_KEY:'' },
  stdio: ['ignore','pipe','inherit'],
})
const stopped = once(server, 'exit')
const sockets = []
function receive(socket, event, matches) {
  return new Promise((resolve, reject) => {
    const done = (value) => {
      if (!matches(value)) return
      clearTimeout(timer)
      socket.off(event, done)
      resolve(value)
    }
    const timer = setTimeout(() => {
      socket.off(event, done)
      reject(new Error(`等待 ${event} 超时`))
    }, 8000)
    socket.on(event, done)
  })
}
async function send(socket, event, payload) {
  const reply = await socket.timeout(4000).emitWithAck(event, payload)
  assert.equal(reply.ok, true, reply.error)
  return reply
}
try {
  const lines = createInterface({input:server.stdout})
  const ready = async () => {
    for await (const line of lines) {
      const event = JSON.parse(line)
      if (event.event === 'ready') return event.url
    }
    throw new Error('演练服务未就绪')
  }
  const url = await ready()
  async function login(account, pin) {
    return fetch(url + '/api/conversations', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({account,pin})})
  }
  assert.equal((await login('B','1111')).status, 401)
  async function connect(auth, event, matches = () => true) {
    const socket = io(url, {auth, forceNew:true, autoConnect:false, reconnection:false})
    sockets.push(socket)
    const connected = receive(socket, event, matches)
    socket.connect()
    return [socket, await connected]
  }
  const session = await (await login('A','1111')).json()
  const [customer, initial] = await connect({role:'customer', ...session}, 'snapshot')
  assert.equal(initial.commerce.account, 'A')
  const [agent] = await connect({role:'agent'}, 'queue')
  const [debug] = await connect({role:'debug'}, 'diagnostics:ready')
  async function query(socket, query, status) {
    const result = receive(socket, 'snapshot', s => !s.generating && s.messages.at(-1)?.commerceCard?.status === status)
    await send(socket, 'customer:commerce', {...query,requestId:randomUUID()})
    return (await result).messages.at(-1).commerceCard
  }
  const order = await query(customer, {action:'order',orderId:'DEMO-1001'}, 'found')
  assert.ok(order.facts.some(f => f.value.includes('已签收')))
  const old = await query(customer, {action:'return',orderId:'DEMO-1001'}, 'expired')
  assert.equal(old.sources[0].version, 'V1')
  assert.equal(old.deadline, '2026-11-23 23:59:59')
  const current = await query(customer, {action:'return',orderId:'DEMO-1002'}, 'eligible')
  assert.equal(current.sources[0].version, 'V2')
  assert.equal(current.deadline, '2026-11-30 23:59:59')
  const evidence = (await send(debug,'debug:read',{id:session.id})).report
  assert.equal(evidence.selected.commerce.length, 4)
  assert.ok(evidence.selected.commerce.every(m => m.state === 'ok'))
  assert.doesNotMatch(JSON.stringify(evidence), /DEMO-|旅行杯|1111|签收次日为/)
  console.log('通过：查本人订单、旧新版截止日、四个独立调试节点及诊断隐私。')
  const queued = receive(agent,'queue', q => q.some(s => s.id === session.id && s.mode === 'waiting'))
  await send(customer,'customer:handoff',{})
  assert.deepEqual((await queued).find(s => s.id === session.id).commerce.latestCard,current)
  await send(agent,'agent:claim',{id:session.id})
  const delivered = receive(customer,'snapshot', s => s.messages.at(-1)?.role === 'agent')
  await send(agent,'agent:send',{id:session.id,text:'已核对 V2 条款和签收日期。',requestId:randomUUID()})
  assert.equal((await delivered).mode,'human')
  console.log('通过：坐席收到相同的交接依据，在原会话接单并回复。')
  const other = await (await login('B','2222')).json()
  const [b, bInitial] = await connect({role:'customer',...other},'snapshot')
  assert.ok(bInitial.commerce.orders.every(o => o.id !== 'DEMO-1001'))
  const denied = await query(b,{action:'order',orderId:'DEMO-1001'},'not_found')
  const missing = await query(b,{action:'order',orderId:'DEMO-9999'},'not_found')
  assert.deepEqual(denied,missing)
  const privateLookup = (await send(debug,'debug:read',{id:other.id})).report.selected.commerce
  assert.deepEqual(privateLookup.map(m=>[m.id,m.state]), [['identity','ok'],['orders','blocked'],['policy','idle'],['eligibility','idle']])
  const slow = await (await login('A','1111')).json()
  const [c] = await connect({role:'customer',...slow},'snapshot')
  const card = await query(c,{action:'return',orderId:'DEMO-1004'},'review')
  assert.match(card.reason,/超时/)
  const timeout = (await send(debug,'debug:read',{id:slow.id})).report
  assert.equal(timeout.selected.mode,'waiting')
  assert.equal(timeout.selected.commerce.find(m => m.id === 'orders').state,'error')
  assert.equal(timeout.selected.commerce.find(m => m.id === 'identity').state,'ok')
  assert.equal(timeout.selected.stages.find(s => s.id === 'ai').state,'skipped')
  console.log('通过：跨账号查询与查无此单反馈一致；订单接口超时自动转人工，地图定位到订单查询。')
  if (process.argv.includes('--merchant')) {
    const { acceptMerchant } = await import('./accept-merchant.mjs')
    await acceptMerchant({url, login, connect, query, send, receive})
  }
  if (process.argv.includes('--feedback')) {
    const { acceptFeedback } = await import('./accept-feedback.mjs')
    await acceptFeedback({url, login, connect, send, receive})
  }
  if (process.argv.includes('--upgrade')) {
    const { acceptUpgrade } = await import('./accept-upgrade.mjs')
    await acceptUpgrade({url, login, connect, send, receive})
  }
  if (process.argv.includes('--trace')) {
    const {acceptTrace}=await import('./accept-trace.mjs')
    await acceptTrace({url,login,connect,send,receive})
  }
} finally {
  sockets.forEach(s => s.disconnect())
  server.kill()
  await stopped
  await rm(data, {recursive:true,force:true,maxRetries:3})
}
