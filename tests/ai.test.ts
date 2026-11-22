import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateReply, explainReturn } from '../server/ai.ts'
import type { Message } from '../shared/protocol.ts'

const customerMessage: Message = { id: 'm1', role: 'customer', text: '可以查一下订单吗？', at: 1 }

async function collect(reply: AsyncIterable<string>) {
  const chunks: string[] = []
  for await (const chunk of reply) {
    chunks.push(chunk)
  }
  return chunks
}

function deepSeekStream(
  parts: Array<{ content?: string; reasoning_content?: string }>,
  finishReason = 'stop',
) {
  const chunk = (delta: Record<string, string>, finish_reason: string | null = null) => ({
    id: 'test-completion',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'deepseek-flash',
    choices: [{ index: 0, delta, finish_reason }],
  })

  const events = [
    ...parts.map((part) => chunk({ ...part })),
    chunk({}, finishReason),
  ]

  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function stubPendingFetch() {
  return new Promise<AbortSignal>((started, failed) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const signal = init?.signal
      if (!signal) {
        const error = new Error('Missing provider signal')
        failed(error)
        throw error
      }
      const pending = new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      started(signal)
      return pending
    }))
  })
}

describe('generateReply', () => {
  beforeEach(() => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'unit-test-only')
    vi.stubEnv('DEEPSEEK_MODEL', undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('calls DeepSeek directly and streams only customer-visible text', async () => {
    const fetchStub = vi.fn<typeof fetch>().mockImplementation(async () => deepSeekStream([
      { reasoning_content: 'private reasoning' },
      { content: '请提供' },
      { content: '订单编号。' },
    ]))
    vi.stubGlobal('fetch', fetchStub)

    const messages: Message[] = [
      { id: 'm0', role: 'agent', text: '您好。', at: 0 },
      { id: 's1', role: 'system', text: 'AI 已恢复接待', at: 0 },
      customerMessage,
    ]
    const chunks = await collect(generateReply(messages, new AbortController().signal))

    expect(chunks).toEqual(['请提供', '订单编号。'])
    expect(fetchStub).toHaveBeenCalledTimes(1)
    const [url, init] = fetchStub.mock.calls[0]!
    expect(String(url)).toBe('https://api.deepseek.com/chat/completions')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer unit-test-only')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'deepseek-flash',
      stream: true,
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: expect.stringContaining('核实') },
        { role: 'assistant', content: '您好。' },
        { role: 'user', content: customerMessage.text },
      ],
    })
  })

  it('uses the configured model on the same provider', async () => {
    vi.stubEnv('DEEPSEEK_MODEL', '  deepseek-v4-pro  ')
    const fetchStub = vi.fn<typeof fetch>().mockImplementation(async () => deepSeekStream([{ content: '您好。' }]))
    vi.stubGlobal('fetch', fetchStub)

    await collect(generateReply([customerMessage], new AbortController().signal))

    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchStub.mock.calls[0]![1]?.body))).toMatchObject({ model: 'deepseek-v4-pro' })
  })

  it('uses a constrained tool to explain the verified rule and keeps the order number local', async () => {
    const fetchStub = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      id:'test', object:'chat.completion', created:1, model:'deepseek-flash',
      choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,
        tool_calls:[{id:'call-1',type:'function',function:{name:'explain_basis',arguments:'{"focus":"deadline"}'}}]}}],
      usage:{prompt_tokens:8,completion_tokens:4,total_tokens:12},
    }))
    vi.stubGlobal('fetch', fetchStub)
    const result = await collect(explainReturn({
      kind:'return',status:'expired',title:'已过期',summary:'已超过退货期限。',request:'退款',facts:[],
      sources:[{id:'R',version:'V1',title:'退货条款',text:'签收次日算第 1 天，期限为 7 天。'}],
      deadline:'2026-11-23 23:59:59',nextStep:'联系坐席',missing:[],reason:'期限已过',asOf:'2026-11-24',orderId:'DEMO-PRIVATE'
    }, '为什么过期了', new AbortController().signal))
    expect(result.join('')).toContain('7 天')
    expect(result.join('')).toContain('2026-11-23')
    expect(result.join('')).toContain('V1')
    expect(String(fetchStub.mock.calls[0][1]?.body)).not.toContain('DEMO-PRIVATE')
  })

  it('propagates upstream failures without retries or substitute text', async () => {
    const fetchStub = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      error: { message: 'temporarily unavailable', type: 'server_error' },
    }, { status: 503 }))
    vi.stubGlobal('fetch', fetchStub)

    await expect(collect(generateReply([customerMessage], new AbortController().signal))).rejects.toThrow()
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('rejects when the provider finishes without visible text', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => deepSeekStream([])))

    await expect(collect(generateReply([customerMessage], new AbortController().signal))).rejects.toThrow()
  })

  it('rejects a reply cut short by the provider output limit', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => deepSeekStream([
      { content: '您可以通过' },
    ], 'length')))

    await expect(collect(generateReply([customerMessage], new AbortController().signal))).rejects.toThrow('length')
  })

  it('propagates cancellation to an in-flight provider request', async () => {
    const started = stubPendingFetch()
    const controller = new AbortController()
    const reply = collect(generateReply([customerMessage], controller.signal))
    const rejection = expect(reply).rejects.toThrow()
    const signal = await started
    controller.abort()
    await rejection
    expect(signal.aborted).toBe(true)
  })

  it('aborts provider requests when the 45-second deadline expires', async () => {
    const started = stubPendingFetch()
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const reply = collect(generateReply([customerMessage], new AbortController().signal))
    const rejection = expect(reply).rejects.toThrow('model deadline expired')
    const signal = await started

    expect(timeout).toHaveBeenCalledWith(45_000)
    deadline.abort(new DOMException('model deadline expired', 'TimeoutError'))
    await rejection
    expect(signal.aborted).toBe(true)
  })

  it('fails explicitly before calling the provider when credentials are missing', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', undefined)
    const fetchStub = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchStub)

    await expect(collect(generateReply([customerMessage], new AbortController().signal))).rejects.toThrow('DEEPSEEK_API_KEY')
    expect(fetchStub).not.toHaveBeenCalled()
  })
})
