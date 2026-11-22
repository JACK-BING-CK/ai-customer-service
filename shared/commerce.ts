export type DemoAccount = 'A' | 'B'
export type CommerceQuery =
  | { kind: 'order' | 'return'; orderId: string; partial?: boolean; line?: number; quantity?: number }
  | { kind: 'faq'; question: string }

export interface PolicySource {
  id: string
  version: string
  title: string
  text: string
}

export interface CommerceCard {
  kind: CommerceQuery['kind']
  status: 'found' | 'eligible' | 'expired' | 'review' | 'login_required' | 'not_found' | 'select_line'
  title: string
  summary: string
  request: string
  facts: { label: string; value: string }[]
  sources: PolicySource[]
  /** Fixture store time (Asia/Shanghai), already formatted for display. */
  asOf: string
  deadline: string | null
  nextStep: string
  missing: string[]
  reason: string
  /** Only present after checking that this conversation owns the order. */
  orderId?: string
  selectedLine?: {line: number; sku: string; description: string; quantity: number}
}

export interface CommerceState {
  account: DemoAccount | null
  orders: { id: string; label: string; lines?: {line: number; description: string; quantity: number}[] }[]
  latestCard: CommerceCard | null
  asOf: string
}

export interface CommerceResult { card: CommerceCard; handoff: boolean }
export interface CommerceTrace {
  step: 'identity' | 'orders' | 'policy' | 'eligibility'
  outcome: 'ok' | 'blocked' | 'error'
  code: string
  elapsedMs: number
  version?: string
}
