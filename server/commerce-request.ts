import type { CommerceCard, CommerceQuery } from '../shared/commerce.ts'

export function readCommerceAction(input: unknown) {
  if (!input || typeof input !== 'object') return null
  const { action, orderId, text, requestId, line, quantity } = input as Record<string, unknown>
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) return null
  const selected = line !== undefined || quantity !== undefined
  if (selected && (action !== 'return' || typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1 ||
    typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1)) return null
  if (action === 'faq' && typeof text === 'string' && text.trim() && text.length <= 2000) {
    const query: CommerceQuery = { kind: 'faq', question: text.trim() }
    return {text: query.question, requestId, query}
  }
  if ((action !== 'return' && action !== 'order') || typeof orderId !== 'string' ||
    !orderId.trim() || orderId.length > 64 || /[\r\n]/u.test(orderId)) return null
  const query: CommerceQuery = { kind: action, orderId: orderId.trim().toUpperCase() }
  if (typeof line === 'number' && typeof quantity === 'number') {
    return {text:`订单 ${query.orderId} 第 ${line} 行想退 ${quantity} 件，可以退货吗？`,requestId,query:{...query,line,quantity}}
  }
  return {text: action === 'return' ? `订单 ${query.orderId} 可以退货吗？` : `查询订单 ${query.orderId} 的物流。`, requestId, query}
}

export function asksForBasis(text: string, card?: CommerceCard | null) {
  return card?.kind === 'return' && (card.status === 'eligible' || card.status === 'expired') &&
    /^(?:请|请问|那|能否|可以|能不能|帮我|再|麻烦)*(?:为什么|为啥|怎么判断的|依据是什么|解释(?:一下)?(?:这次判断|判断依据|这个结果)|这个日期怎么(?:算|来)的)(?:能退|不能退|过期了|是这个结果|呢|吗|呀|啊|一下|[？?。！!\s])*$/u.test(text)
}

export function chatPriority(text:string,card?:CommerceCard|null) {
  if (wantsHuman(text)) return 'handoff'
  if (asksForBasis(text,card)) return 'basis'
  return 'chat'
}

/** Route when the same question is present in the approved FAQ library. */
export type FaqReplayRoute='chat'|'explicit_faq'|'explicit_order'|'order'|'handoff'|'basis'|'in_service'|'unknown'

function wantsHuman(text: string) {
  if (text.length > 60) return false
  const compact = text.replace(/[\s,，、；;。.!！?？]/gu, '')
  const request = compact.replace(/^(?:你好|您好)?(?:请问|请|麻烦|拜托|帮我|我想要|想要|我想|想|我要|我需要|能否|能不能|可不可以|可以|怎么|如何|给我|我能)*/u, '')
  if (/^(?:转接?|联系|接通|找|叫|换|安排|接)?(?:一下)?(?:到|给|成)?(?:一位|一个)?(?:人工客服|人工服务|真人客服|真人|人工)(?:处理|服务|吗|吧|一下|谢谢)*$/u.test(request)) return true
  if (/^(?:和|跟|与)(?:一位|一个)?(?:人工客服|真人客服|真人|人工)(?:沟通|说话|聊天|聊聊|聊一下|聊|对话|通话)(?:吗|吧|谢谢)*$/u.test(request)) return true
  return /^(?:please\s+)?(?:(?:can i|could i|can you|could you|i want to|i need to)\s+)?(?:(?:speak|talk)\s+(?:to|with)\s+|(?:transfer|connect)\s+me\s+to\s+|i want\s+|i need\s+)?(?:a\s+|an\s+)?(?:human(?:\s+agent)?|live\s+agent|real\s+person)(?:\s+please)?[.!?]*$/iu.test(text)
}

