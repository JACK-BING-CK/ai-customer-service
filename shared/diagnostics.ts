import type { Mode } from './protocol.ts'

export type FlowStageId = 'customer' | 'ai' | 'queue' | 'agent' | 'reply'
export type BusinessModuleId = 'identity' | 'orders' | 'policy' | 'eligibility'
export const feedbackModuleLabels = { feedback: '坐席反馈', revision: '运营修订', replay: '历史回放', publication: '修订发布' } as const
export type FeedbackModuleId = keyof typeof feedbackModuleLabels
export type StageState = 'pending' | 'active' | 'done' | 'failed' | 'skipped' | 'cancelled' | 'unknown'
export interface FlowStage {
  id: FlowStageId
  state: StageState
  label: string
  detail: string
  at: number | null
}
export interface DiagnosticEvent {
  at: number
  module: string
  event: string
  label: string
  detail: string
  stage: FlowStageId | 'commerce' | 'feedback'
  failed: boolean
}
export interface SessionSummary { id: string; mode: Mode; createdAt: number; updatedAt: number }
export interface LifecycleEvent { kind: 'resolved' | 'reopened'; at: number; by?: 'customer' }
export interface DiagnosticSession extends SessionSummary {
  lifecycle?: LifecycleEvent[]
  stages: FlowStage[]
  events: DiagnosticEvent[]
  historyLimited: boolean
  commerce: ModuleStatus[]
  feedback: ModuleStatus[]
  otherFeedback?: { caseId: string; modules: ModuleStatus[] }[]
}
export interface ShopBlock {
  at: number
  status: string
  details: string[]
  feedbackCaseIds?: string[]
}
export interface ModuleStatus {
  id: 'storage' | 'realtime' | 'ai' | 'routing' | 'merchant' | BusinessModuleId | FeedbackModuleId
  label: string
  state: 'ok' | 'active' | 'idle' | 'blocked' | 'error' | 'unknown'
  status: string
  detail: string
  at: number | null
  recentBlocks?: ShopBlock[]
  feedbackCaseId?: string
}
export interface DiagnosticReport {
  checkedAt: number
  evidence: {
    requestAt: number
    logReadable: boolean
    connections: {
      customers: number; agents: number; selectedCustomers: number | null
      customerViews: number | null; agentViews: number | null
      selectedCustomerViews: number | null; selectedAgentViews: number | null; lastViewAt: number | null
    }
  }
  sessions: SessionSummary[]
  selected: DiagnosticSession | null
  modules: ModuleStatus[]
}
export interface DiagnosticQuery { id?: string; search?: string }
export type DiagnosticReply = { ok: true; report: DiagnosticReport } | { ok: false; error: string }
