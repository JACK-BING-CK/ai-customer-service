import { staffAccess } from './staff-access.ts'
import type { Server, Socket } from 'socket.io'
import type { Ack } from '../shared/protocol.ts'
import type { DiagnosticQuery, DiagnosticReply, DiagnosticReport } from '../shared/diagnostics.ts'
import { log } from './log.ts'
import type { Service } from './service.ts'
import type { Store } from './store.ts'

type Actor = { role: 'customer'; id: string } | { role: 'agent' } | { role: 'debug' }
type Callback = (ack: Ack) => void

const staffRoom = 'support:staff'
const archiveRoom = 'support:archive'
const monitorRoom = 'support:diagnostics'
const forbidden: Ack = { ok: false, error: '当前会话账号没有此权限。' }
const invalidRequest: Ack = { ok: false, error: '会话编号无效。' }

function customerRoom(id: string) {
  return `support:conversation:${id}`
}

export function notifyDiagnostics(io: Server) {
  io.to(monitorRoom).emit('diagnostics:changed')
}

function inputId(input: unknown) {
  if (!input || typeof input !== 'object' || !('id' in input)) return null
  return typeof input.id === 'string' && input.id.length === 36 ? input.id : null
}

export function bindRealtime(io: Server, service: Service, store: Store, agentKey?: string,
  readDiagnostics?: (query: DiagnosticQuery) => DiagnosticReport) {
  const allowStaff = staffAccess(agentKey)
  let pendingUpdate: ReturnType<typeof setTimeout> | undefined
  function invalidateMonitor() {
    if (pendingUpdate || !io.of('/').adapter.rooms.has(monitorRoom)) return
    pendingUpdate = setTimeout(() => {
      pendingUpdate = undefined
      notifyDiagnostics(io)
    }, 200)
    pendingUpdate.unref()
  }

  io.use((socket, next) => {
    const { role, id, token } = socket.handshake.auth
    let actor: Actor | undefined
    const hasToken = typeof token === 'string' && token.length <= 4096
    if ((role === 'agent' || role === 'debug') && allowStaff(token)) {
      actor = { role }
    }
    if (role === 'customer' && hasToken && typeof id === 'string' && store.authenticate(id, token)) {
      actor = { role, id }
    }
    if (!actor) {
      log('realtime', 'authentication_denied', { role: role === 'customer' || role === 'agent' || role === 'debug' ? role : 'unknown' })
      next(Object.assign(new Error('unauthorized'), { data: { code: 'UNAUTHORIZED' } }))
      return
    }
    socket.data.actor = actor
    next()
  })

  function handle(socket: Socket, actor: Actor, event: string, requiredRole: Actor['role'], action: (input: unknown) => Ack) {
    socket.on(event, (input: unknown, ack?: Callback) => {
      if (typeof ack !== 'function') return
      if (actor.role !== requiredRole) {
        const fields: Record<string, string> = { action: event, role: actor.role }
        if (actor.role === 'customer') fields.conversationId = actor.id
        log('realtime', 'authorization_denied', fields)
        ack(forbidden)
        return
      }
      let result: Ack
      try {
        result = action(input)
      } catch {
        log('realtime', 'request_failed', { action: event, role: actor.role })
        result = { ok: false, error: '服务暂时不可用，请重试。' }
      }
      ack(result)
    })
  }

  async function connect(socket: Socket) {
    const actor = socket.data.actor as Actor
    socket.on('debug:read', (input: DiagnosticQuery | null, ack?: (result: DiagnosticReply) => void) => {
      if (typeof ack !== 'function') return
      if (actor.role !== 'debug') return ack({ ok: false, error: '请从独立调试后台查看。' })
      if (!readDiagnostics) return ack({ ok: false, error: '流程监控尚未就绪。' })
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || (input.id !== undefined && (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.id)))
        || (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 64))) {
        return ack({ ok: false, error: '请检查会话编号后重试。' })
      }
      try {
        const report = readDiagnostics({ id: input.id, search: input.search })
        void socket.join(monitorRoom)
        ack({ ok: true, report })
      } catch {
        log('diagnostics', 'read_failed')
        ack({ ok: false, error: '读取诊断数据失败，请检查服务日志后重试。' })
      }
    })
    socket.on('debug:leave', () => { void socket.leave(monitorRoom) })
    if (actor.role !== 'debug') {
      socket.on('client:view', (input: {id?: unknown} | null) => {
        if (!input || (input.id !== null && !inputId(input))) return
        if (actor.role === 'customer' && input.id !== null && input.id !== actor.id) return
        socket.data.view = input.id ? { id: input.id, at: Date.now() } : null
        invalidateMonitor()
      })
    }
    socket.on('disconnect', invalidateMonitor)
    invalidateMonitor()
    const customerId = actor.role === 'customer' ? actor.id : ''
    handle(socket, actor, 'customer:send', 'customer', (input) => service.sendCustomer(customerId, input))
    handle(socket, actor, 'customer:commerce', 'customer', (input) => service.sendCommerce(customerId, input))
    handle(socket, actor, 'customer:handoff', 'customer', () => service.requestHandoff(customerId))
    handle(socket,actor,'customer:resolve','customer',input=>{
      const version=input && typeof input==='object' && 'version' in input ? input.version : null
      return typeof version==='number' ? service.resolve(customerId,version,'customer') : invalidRequest
    })
    handle(socket, actor, 'agent:claim', 'agent', (input) => {
      const id = inputId(input)
      return id ? service.claim(id) : invalidRequest
    })
    handle(socket, actor, 'agent:send', 'agent', (input) => {
      const id = inputId(input)
      return id ? service.sendAgent(id, input) : invalidRequest
    })
    handle(socket, actor, 'agent:resolve', 'agent', (input) => {
      const id = inputId(input)
      const version = input && typeof input === 'object' && 'version' in input ? input.version : null
      return id && typeof version === 'number' ? service.resolve(id,version) : invalidRequest
    })

    if (actor.role === 'customer') {
      await socket.join(customerRoom(actor.id))
      const snapshot = service.snapshot(actor.id)
      if (snapshot) socket.emit('snapshot', snapshot)
      return
    }
    if (actor.role === 'debug') {
      socket.emit('diagnostics:ready')
      return
    }
    const archive = socket.handshake.auth.archive === true
    await socket.join(archive ? archiveRoom : staffRoom)
    socket.emit('queue', service.listQueue(archive))
  }

  io.on('connection', (socket) => {
    void connect(socket).catch(() => {
      log('realtime', 'sync_failed')
      socket.disconnect(true)
    })
  })

  return (id: string) => {
    invalidateMonitor()
    const snapshot = service.snapshot(id)
    if (!snapshot) return
    io.to(customerRoom(id)).emit('snapshot', snapshot)
    if (snapshot.mode !== 'ai') io.to(staffRoom).emit('queue', service.listQueue())
    if ((snapshot.mode === 'resolved' || snapshot.mode === 'waiting') && io.of('/').adapter.rooms.has(archiveRoom)) {
      io.to(archiveRoom).emit('queue',service.listQueue(true))
    }
  }
}
