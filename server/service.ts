import type { Ack, Message } from '../shared/protocol.ts'
import { log } from './log.ts'
import type { Store } from './store.ts'
import type { CommerceCard, CommerceQuery } from '../shared/commerce.ts'
import { openCommerce } from './commerce.ts'
import { asksForBasis, chatPriority, readCommerceAction, type FaqReplayRoute } from './commerce-request.ts'
import { explainReturn } from './ai.ts'
import { appendTrace } from './trace-store.ts'

export type Generate = (messages: Message[], signal: AbortSignal) => AsyncIterable<string>
type Generation = { controller: AbortController; draft: string; kind: 'ai' | 'commerce'; causeMessageId:string }
type Cancellation = 'new_message' | 'human_handoff' | 'shutdown'

const ok: Ack = { ok: true }
const notFound: Ack = { ok: false, error: '会话不存在。' }
const invalidRequest: Ack = { ok: false, error: '请检查消息和请求编号后重试。' }
const duplicateConflict: Ack = { ok: false, error: '这条请求编号已经用于另一条消息。' }
const limits = { message: 4000, requestId: 128, generated: 40_000 }

function readMessage(input: unknown) {
  if (!input || typeof input !== 'object') return null
  const { text, requestId } = input as Record<string, unknown>
  if (typeof text !== 'string' || typeof requestId !== 'string' || text.length > limits.message || requestId.length > limits.requestId) return null
  const cleaned = text.trim()
  if (!cleaned || !requestId.trim()) return null
  return { text: cleaned, requestId }
}

function safeFailure(error: unknown): Record<string, string | number> {
  if (!error || typeof error !== 'object') return { kind: 'unknown' }
  const { statusCode, name, code, cause } = error as Record<string, unknown>
  if (typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) {
    return { kind: 'provider_http', statusCode }
  }
  const causeCode = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
  const timeoutCodes = ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']
  if (name === 'TimeoutError' || timeoutCodes.some((value) => value === code || value === causeCode)) return { kind: 'timeout' }
  if (name === 'AbortError') return { kind: 'aborted' }
  return { kind: 'generation_error' }
}

export function createService(store: Store, generate: Generate, notify: (id: string) => void,
  commerce?: ReturnType<typeof openCommerce>) {
  const active = new Map<string, Generation>()
  let closed = false

  function publish(id: string) {
    try {
      notify(id)
    } catch {
      log('conversation', 'publish_failed', { conversationId: id })
    }
  }

  function snapshot(id: string) {
    const persisted = store.snapshot(id)
    if (persisted && commerce) persisted.commerce = commerce.state(id)
    const generation = active.get(id)
    if (persisted?.mode === 'ai' && generation) {
      persisted.generating = true
      persisted.draft = generation.draft
    }
    return persisted
  }

  function cancelGeneration(id: string, reason: Cancellation) {
    const generation = active.get(id)
    if (!generation) return
    active.delete(id)
    generation.controller.abort()
    appendTrace(store.database,{kind:generation.kind==='ai' ? 'ai.cancelled' : 'commerce.cancelled',
      conversationId:id,status:'info',details:{causeMessageId:generation.causeMessageId,code:reason}})
    log(generation.kind, generation.kind === 'ai' ? 'generation_cancelled' : 'cancelled', { conversationId: id, reason })
  }

  async function runGeneration(id: string, messages: Message[], generation: Generation, basis?: CommerceCard) {
    const { signal } = generation.controller
    try {
      const stream = basis ? explainReturn(basis, messages.at(-1)!.text, signal) : generate(messages, signal)
      for await (const chunk of stream) {
        if (active.get(id) !== generation || signal.aborted) return
        if (!chunk) continue
        if (typeof chunk !== 'string' || generation.draft.length + chunk.length > limits.generated) throw new Error('Invalid reply')
        generation.draft += chunk
        store.bumpVersion(id)
        publish(id)
      }
      if (active.get(id) !== generation || signal.aborted) return
      const reply = generation.draft.trim()
      if (!reply) throw new Error('Empty reply')
      const result = store.append(id, 'assistant', reply, { requiredMode: 'ai',causeMessageId:generation.causeMessageId })
      active.delete(id)
      const event = result === 'applied' ? 'generation_completed' : 'generation_discarded'
      if (result!=='applied') appendTrace(store.database,{kind:'ai.cancelled',conversationId:id,status:'info',
        details:{causeMessageId:generation.causeMessageId,code:'discarded'}})
      log('ai', event, { conversationId: id })
      publish(id)
    } catch (error) {
      if (active.get(id) !== generation || signal.aborted) return
      active.delete(id)
      const failure=safeFailure(error)
      log('ai', 'generation_failed', { conversationId: id, ...failure })
      const result = store.append(id, 'system', 'AI 暂时无法回复，已为你转人工。', {
        requiredMode: 'ai', nextMode: 'waiting', handoffReason: 'AI 暂时无法回复，系统已自动转接。',
        causeMessageId:generation.causeMessageId,failedStep:{kind:'ai.failed',code:String(failure.kind)},handoffCode:'ai_failure',
      })
      if (result === 'applied') log('conversation', 'mode_changed', { conversationId: id, mode: 'waiting', reason: 'ai_failure' })
      publish(id)
    }
  }

  async function runCommerce(id: string, query: CommerceQuery, generation: Generation) {
    if (!commerce) return
    try {
      const {card, handoff} = await commerce.ask(id, query, generation.controller.signal,generation.causeMessageId)
      if (active.get(id) !== generation) return
      const written = store.append(id, 'assistant', card.summary, {
        requiredMode: 'ai', commerceCard: card, causeMessageId:generation.causeMessageId, onApplied: () => commerce.saveCard(id, card),
        ...(handoff ? {nextMode: 'waiting', handoffReason: card.reason || card.summary,handoffCode:'commerce_review'} : {}),
      })
      if (handoff && written === 'applied') log('conversation', 'mode_changed', {conversationId:id, mode:'waiting', reason:'commerce_review'})
    } catch {
      if (active.get(id) !== generation) return
      log('commerce', 'failed', {conversationId:id})
      const written = store.append(id, 'system', '业务查询暂时无法完成，已转人工协助核查。', {
        requiredMode: 'ai', nextMode: 'waiting', handoffReason: '业务查询未完成，需要人工核查。',
        causeMessageId:generation.causeMessageId,failedStep:{kind:'commerce.failed',code:'error'},handoffCode:'commerce_review',
      })
      if (written === 'applied') log('conversation', 'mode_changed', {conversationId:id, mode:'waiting', reason:'commerce_review'})
    } finally {
      if (active.get(id) === generation) {
        active.delete(id)
        publish(id)
      }
    }
  }

  function startGeneration(id: string) {
    const current = store.snapshot(id)
    if (closed || current?.mode !== 'ai' || current.messages.at(-1)?.role !== 'customer') return
    cancelGeneration(id, 'new_message')
    const last = current.messages.at(-1)!
    const query = commerce && store.latestQuery(id)
    const latestCard = commerce?.state(id, false).latestCard
    const generation: Generation = { controller: new AbortController(), draft: '', kind: query ? 'commerce' : 'ai',causeMessageId:last.id }
    appendTrace(store.database,{kind:query ? 'commerce.started' : 'ai.started',conversationId:id,status:'info',
      details:{causeMessageId:last.id,...(query && {queryKind:query.kind})}})
    store.bumpVersion(id)
    active.set(id, generation)
    log(generation.kind, query ? 'started' : 'generation_started', { conversationId: id })
    publish(id)
    const work = query ? runCommerce(id, query, generation) :
      runGeneration(id, store.modelHistory(id), generation, latestCard && asksForBasis(last.text, latestCard) ? latestCard : undefined)
    void work.catch(() => {
      log(generation.kind, 'generation_persistence_failed', { conversationId: id })
      publish(id)
    })
  }

  function customerHandoffReason(id: string) {
    return active.get(id)?.kind === 'commerce'
      ? '当前业务查询尚未完成，顾客申请人工协助。请核对聊天中的最新请求，已有办理卡仅记录此前的查询。'
      : '顾客申请人工协助。'
  }

  function requestHandoff(id: string): Ack {
    const current = store.snapshot(id)
    if (!current) return notFound
    if (current.mode !== 'ai') return ok
    if (!store.setMode(id, 'ai', 'waiting', customerHandoffReason(id))) return { ok: false, error: '会话状态刚刚变化，请重试。' }
    cancelGeneration(id, 'human_handoff')
    log('conversation', 'mode_changed', { conversationId: id, mode: 'waiting', reason: 'customer_handoff' })
    publish(id)
    return ok
  }

  queueMicrotask(() => {
    if (closed) return
    try {
      for (const id of store.listPendingAI()) {
        if (!active.has(id)) startGeneration(id)
      }
    } catch {
      log('conversation', 'resume_failed')
    }
  })

  function sendCustomer(id: string, input: unknown, explicitQuery?: CommerceQuery): Ack {
      const message = readMessage(input)
      if (!message) return invalidRequest
      const current = store.snapshot(id)
      if (!current) return notFound
      if (explicitQuery && !commerce) return {ok:false, error:'订单和政策查询尚未就绪。'}

      const card=commerce?.state(id,false).latestCard
      const priority=chatPriority(message.text,card)
      const handoff = !explicitQuery && current.mode === 'ai' && priority==='handoff'
      const reopen = !explicitQuery && current.mode === 'resolved'
      let query = explicitQuery
      let faqRoute:FaqReplayRoute
      if (explicitQuery) faqRoute=explicitQuery.kind==='faq'?'explicit_faq':'explicit_order'
      else if (current.mode!=='ai') faqRoute='in_service'
      else if (priority!=='chat' || !commerce) faqRoute=priority
      else {
        query=commerce.parseQuery(message.text,card?.orderId,id) ?? undefined
        const withFaq=query?.kind==='faq' || commerce.parseQuery(message.text,card?.orderId,id,true)?.kind==='faq'
        faqRoute=withFaq?'chat':'order'
      }
      const result = store.append(id, 'customer', message.text, {
        requestId: message.requestId,
        commerceQuery: query,
        faqRoute,
        ...(explicitQuery ? { requiredMode: 'ai' as const } : {}),
        ...(reopen ? {requiredMode: 'resolved', nextMode: 'waiting'} : {}),
        ...(handoff ? { requiredMode: 'ai', nextMode: 'waiting', handoffReason: customerHandoffReason(id),handoffCode:'customer_message' } : {}),
      })
      if (result === 'duplicate') return ok
      if (result === 'conflict') return duplicateConflict
      if (result === 'missing') return notFound
      if (result === 'wrongMode') return { ok: false, error: '会话已转人工，请在聊天框联系坐席。' }

      if (handoff) {
        cancelGeneration(id, 'human_handoff')
        log('conversation', 'mode_changed', { conversationId: id, mode: 'waiting', reason: 'customer_message' })
      }
      if (reopen) log('conversation', 'mode_changed', {conversationId:id, mode:'waiting', reason:'customer_reopened'})
      if (current.mode === 'ai' && !handoff) startGeneration(id)
      else publish(id)
      return ok
  }

  return {
    snapshot,
    listQueue(archive = false) {
      return store.listQueue(archive).map(s => commerce ? {...s, commerce: commerce.state(s.id, false)} : s)
    },
    isGenerating(id: string) { return active.get(id)?.kind === 'ai' },
    isCheckingOrder(id: string) { return active.get(id)?.kind === 'commerce' },
    activeGenerationCount() { return [...active.values()].filter(item => item.kind === 'ai').length },
    requestHandoff,
    sendCustomer,
    sendCommerce(id: string, input: unknown): Ack {
      const command = readCommerceAction(input)
      return command ? sendCustomer(id, command, command.query) : invalidRequest
    },
    claim(id: string): Ack {
      const current = store.snapshot(id)
      if (!current) return notFound
      if (current.mode === 'human') return ok
      if (!store.setMode(id, 'waiting', 'human')) return { ok: false, error: '当前会话尚未请求人工服务。' }
      log('conversation', 'mode_changed', { conversationId: id, mode: 'human', reason: 'agent_claim' })
      publish(id)
      return ok
    },
    resolve(id: string, version: number, actor:'agent'|'customer'='agent'): Ack {
      if (!Number.isSafeInteger(version) || version < 1) return invalidRequest
      if (actor==='customer' && active.has(id)) return {ok:false,error:'请等本次回复完成后再确认。'}
      const result = store.resolve(id,version,actor)
      if (result === 'missing') return notFound
      if (result === 'changed') return {ok:false,error:'会话已有更新，请查看最新消息后再办结。'}
      if (result === 'unanswered') return {ok:false,error:'收到客服回复后可以确认问题已解决。'}
      if (result === 'applied') {
        log('conversation','mode_changed',{conversationId:id, mode:'resolved',reason:actor==='customer'?'customer_resolved':'agent_resolved'})
        publish(id)
      }
      return ok
    },
    sendAgent(id: string, input: unknown): Ack {
      const message = readMessage(input)
      if (!message) return invalidRequest
      const result = store.append(id, 'agent', message.text, { requestId: message.requestId, requiredMode: 'human' })
      if (result === 'missing') return notFound
      if (result === 'wrongMode') return { ok: false, error: '请先接管会话。' }
      if (result === 'conflict') return duplicateConflict
      if (result === 'applied') publish(id)
      return ok
    },
    shutdown() {
      closed = true
      for (const id of active.keys()) cancelGeneration(id, 'shutdown')
    },
  }
}

export type Service = ReturnType<typeof createService>
