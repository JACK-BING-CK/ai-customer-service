import { createDeepSeek } from '@ai-sdk/deepseek'
import { generateText, streamText, tool, type ModelMessage } from 'ai'
import { z } from 'zod'
import type { Message } from '../shared/protocol.ts'
import type { CommerceCard } from '../shared/commerce.ts'

const replyTimeoutMs = 45_000
const instructions = [
  '你是在线客服助手。使用访客的语言，简洁、礼貌地回答，并给出清楚的下一步。',
  '只有当前对话明确提供的事实可以用来回答具体业务问题。仅凭访客所述不能核实订单、账户、退款、物流状态、金额、期限或公司政策。',
  '缺少已核实的信息时，明确说明无法核实，并请访客使用「转人工」入口。不要编造查询结果，也不要声称已经查单、退款、创建工单或转接人工。',
  '不要要求访客提供密码、验证码、支付卡号或完整证件号码。',
].join('\n')

function configuredModel() {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey) {
    throw new Error('未设置 DEEPSEEK_API_KEY')
  }

  return createDeepSeek({ apiKey }).chat(process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash')
}

// DeepSeek selects the relevant explanation. Dates and the quoted clause always come from the saved decision.
export async function* explainReturn(card: CommerceCard, question: string, signal: AbortSignal): AsyncIterable<string> {
  signal.throwIfAborted()
  const tools = {
    explain_basis: tool({
      description: '根据顾客追问，从已核验的退货卡读取条款、截止时间和结论，选择先解释的依据。',
      inputSchema: z.object({ focus: z.enum(['version', 'deadline', 'eligibility']) }),
      execute: async ({ focus }) => {
        const clause = card.sources.map(s => `《${s.title}》${s.version} 规定：${s.text}`).join('\n')
        const timing = `这笔订单的办理截止时间是 ${card.deadline}（北京时间）。`
        return [card.summary, ...(focus === 'version' ? [clause, timing] : [timing, clause])].join('\n')
      },
    }),
  }
  const result = await generateText({
    model: configuredModel(), tools, toolChoice: {type:'tool', toolName:'explain_basis'},
    prompt: `使用工具解读已核验的${card.status === 'eligible' ? '可申请' : '已过期'}结果。顾客问：${question}`,
    providerOptions: {deepseek: {thinking: {type:'disabled'}}},
    maxRetries: 0, maxOutputTokens: 200, abortSignal: AbortSignal.any([signal, AbortSignal.timeout(replyTimeoutMs)]),
  })
  const evidence = result.toolResults.find(item => item.toolName === 'explain_basis')
  if (!evidence || typeof evidence.output !== 'string') throw new Error('缺少可核验的解读')
  yield evidence.output
}

export async function* generateReply(messages: Message[], signal: AbortSignal): AsyncIterable<string> {
  signal.throwIfAborted()
  const model = configuredModel()
  const history = messages
    .filter((message) => message.role !== 'system')
    .map((message): ModelMessage => ({
      role: message.role === 'customer' ? 'user' : 'assistant',
      content: message.text,
    }))
  const request = new AbortController()
  const requestSignal = AbortSignal.any([signal, request.signal, AbortSignal.timeout(replyTimeoutMs)])
  const result = streamText({
    model,
    instructions,
    messages: history,
    providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
    maxOutputTokens: 1024,
    maxRetries: 0,
    abortSignal: requestSignal,
    onError: () => {}, // Errors are propagated by the stream; don't log provider request details.
  })

  let hasText = false
  let finished = false
  try {
    for await (const part of result.stream) {
      requestSignal.throwIfAborted()
      if (part.type === 'error') {
        throw part.error
      }
      if (part.type === 'abort') {
        throw new Error('DeepSeek 已中断回复')
      }
      if (part.type === 'finish') {
        if (part.finishReason !== 'stop') {
          throw new Error(`DeepSeek 回复未正常完成 (${part.finishReason})`)
        }
        finished = true
      }
      if (part.type === 'text-delta' && part.text) {
        hasText ||= Boolean(part.text.trim())
        yield part.text
      }
    }
    requestSignal.throwIfAborted()
    if (!finished || !hasText) {
      throw new Error('DeepSeek 未完成有效回复')
    }
  } finally {
    if (!finished) {
      request.abort()
    }
  }
}
