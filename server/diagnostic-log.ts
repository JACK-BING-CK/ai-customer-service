import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type { DiagnosticEvent, ShopBlock } from '../shared/diagnostics.ts'
import { businessEvent } from './diagnostic-commerce.ts'
import { shopActivity, type ShopActivity } from './diagnostic-merchant.ts'
import { feedbackEvent, type FeedbackTrace } from './diagnostic-feedback.ts'

export interface TraceEntry extends DiagnosticEvent { conversationId: string; reason?: string; feedback?: FeedbackTrace }

const reasons = new Map<string, string>([
  ['customer_handoff', '顾客点击转人工。'], ['customer_message', '顾客发消息要求转人工。'],
  ['ai_failure', 'AI 回复失败后自动转人工。'], ['agent_claim', '坐席点击开始接待。'],
  ['new_message', '收到新的顾客消息。'], ['human_handoff', '顾客转人工，停止本次生成。'],
  ['shutdown', '服务关闭，停止本次生成。'],
  ['commerce_review', '业务查询需要人工核查，已进入人工队列。'],
  ['agent_resolved','坐席办结会话，已移出待办。'], ['customer_reopened','顾客在原会话追问，重新进入人工队列。'],
  ['customer_resolved','顾客查看回复后确认问题已解决。'],
])

function safeEntry(line: string): TraceEntry | ShopActivity | undefined {
  let raw
  try { raw = JSON.parse(line) } catch { return }
  if (!raw || typeof raw !== 'object' || typeof raw.at !== 'string' ||
      typeof raw.module !== 'string' || typeof raw.event !== 'string') return
  const at = Date.parse(raw.at)
  if (!Number.isFinite(at)) return
  if (raw.module === 'merchant') return shopActivity(raw, at)
  if (typeof raw.conversationId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(raw.conversationId)) return
  if (raw.module === 'feedback') return feedbackEvent(raw, at, raw.conversationId)
  const entry = (stage: DiagnosticEvent['stage'], label: string, detail = '', failed = false): TraceEntry => ({
    at, stage, label, detail, failed, module: raw.module, event: raw.event, conversationId: raw.conversationId,
    reason: reasons.has(raw.reason) ? raw.reason : undefined,
  })
  const reason = reasons.get(raw.reason) ?? ''
  const business = businessEvent(raw.module, raw.event, raw.elapsedMs, raw.version)
  if (business) return entry('commerce', business.label, business.detail, business.failed)
  switch (raw.module + '.' + raw.event) {
    case 'session.created': return entry('customer', '会话已建立')
    case 'commerce.started': return entry('commerce', '开始处理业务查询')
    case 'commerce.cancelled': return entry('commerce', '业务查询已中止', reason)
    case 'commerce.failed': return entry('commerce', '业务查询中断', '业务查询未完成，已请求人工核查。', true)
    case 'commerce.generation_persistence_failed': return entry('commerce', '业务结果处理异常', '请检查会话存储和服务端运行日志。', true)
    case 'ai.generation_started': return entry('ai', '开始生成 AI 回复')
    case 'ai.generation_completed': return entry('ai', 'AI 回复已生成并保存')
    case 'ai.generation_cancelled': return entry('ai', '本次 AI 生成已取消', reason)
    case 'ai.generation_discarded': return entry('ai', '本次 AI 回复未写入', '生成结束后会话状态已变化。')
    case 'ai.generation_persistence_failed': return entry('ai', 'AI 结果处理异常', '检查会话存储和服务端运行日志。', true)
    case 'ai.generation_failed': {
      const status = raw.statusCode
      const detail = raw.kind === 'timeout' ? '模型请求超时。'
        : raw.kind === 'provider_http' && Number.isInteger(status) && status >= 100 && status <= 599
          ? `模型服务返回 HTTP ${status}。` : '模型未返回可用回复。'
      return entry('ai', 'AI 生成失败', detail, true)
    }
    case 'conversation.mode_changed':
      if (raw.mode === 'resolved' && raw.reason==='customer_resolved') return entry('customer','顾客确认已解决',reason)
      if (raw.mode === 'resolved') return entry('agent', '坐席已办结', reason)
      if (raw.reason === 'customer_reopened' && raw.mode === 'waiting') return entry('queue','顾客追问重开',reason)
      if (raw.mode === 'waiting') return entry('queue', '进入人工队列', reason)
      if (raw.mode === 'human') return entry('agent', '坐席已接单', reason)
      return
    case 'conversation.publish_failed': return entry('queue', '会话状态推送失败', '检查实时连接和服务端日志。', true)
  }
}

// Read only new bytes on refresh. Retain a bounded tail for existing large logs.
const byteLimit = 1024 * 1024
const entryLimit = 4096
export function createTraceReader(path: string) {
  let offset = 0
  let identity = ''
  let mtime = 0
  let remainder = Buffer.alloc(0)
  let entries: TraceEntry[] = []
  let shop: ShopActivity | null = null
  let recentBlocks: ShopBlock[] = []
  return () => {
    let fd: number | undefined
    try {
      fd = openSync(path, 'r')
      const stat = fstatSync(fd)
      const key = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
      const reset = key !== identity || stat.size < offset || (stat.size === offset && stat.mtimeMs !== mtime)
      if (reset || stat.size - offset > byteLimit) {
        offset = Math.max(0, stat.size - byteLimit)
        entries = []
        shop = null
        recentBlocks = []
        remainder = Buffer.alloc(0)
      }
      if (stat.size > offset) {
        const buf = Buffer.alloc(stat.size - offset)
        const count = readSync(fd, buf, 0, buf.length, offset)
        const bytes = Buffer.concat([remainder, buf.subarray(0, count)])
        const end = bytes.lastIndexOf(10)
        const lines = end < 0 ? [] : bytes.subarray(0, end).toString('utf8').split('\n')
        for (const line of lines) {
          const parsed = safeEntry(line)
          if (parsed) {
            if ('conversationId' in parsed) entries.push(parsed)
            else {
              shop = parsed
              if (parsed.block) recentBlocks = [parsed.block, ...recentBlocks].slice(0, 10)
            }
          }
        }
        if (entries.length > entryLimit) entries = entries.slice(-entryLimit)
        remainder = Buffer.from(bytes.subarray(end + 1, bytes.length).subarray(-byteLimit))
        offset += count
      }
      identity = key
      mtime = stat.mtimeMs
      return { entries, shop, recentBlocks, available: true }
    } catch {
      return { entries: [], shop: null, recentBlocks: [], available: false }
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
}
