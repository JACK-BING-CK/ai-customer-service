import type { MerchantRow, TrialReport } from './merchant.ts'

export const feedbackReasons = {
  faq_gap:'没有对应问答', faq_wrong:'问答有误', policy_issue:'政策判断需修订',
  missing_facts:'订单或商品事实不足', technical:'系统或接口异常', customer_request:'顾客主动要求人工', other:'其他原因',
} as const
export type FeedbackReason = keyof typeof feedbackReasons
export type FeedbackExpected =
  | {kind:'faq'; answer:string}
  | {kind:'policy'; status:'eligible'|'expired'|'review'; versions?:string[]; deadline?:string|null}
  | {kind:'none'}
export interface FeedbackInput { messageId:string; reason:FeedbackReason; note?:string; expected:FeedbackExpected }
export interface FeedbackDraftInput { kind:'faq'|'policy'; row:MerchantRow; orderIds?:string[]; contrastQuestions?:string[] }
export interface FaqContrastResult { question:string; excludedId:string; actual:string; passed:boolean }
export interface FeedbackReplayRow {
  caseId:string; question:string; expected:string; before:string; after:string; passed:boolean; detail:string
  checks?:PolicyReplayCheck[]
}
export const policyCheckLabels = {status:'退货判断',versions:'条款版本',deadline:'截止时间'} as const
export const policyStatusLabels = {eligible:'可申请退货',expired:'已过退货申请期限',review:'需要人工核对'} as const
export interface PolicyReplayCheck {field:keyof typeof policyCheckLabels; expected:string; actual:string; passed:boolean}
export type PolicyMismatch = Omit<PolicyReplayCheck,'passed'> & {caseId:string}
export const policyRefPattern = /^[^@\s\p{Cc}]{1,64}@[^@\s\p{Cc}]{1,64}$/u
export function policyCheckDetail(check:Omit<PolicyReplayCheck,'passed'>) {
  return `${policyCheckLabels[check.field]}：预期 ${check.expected}，实际 ${check.actual}。`
}
export interface FeedbackReplay {
  at:number; passed:boolean; rows:FeedbackReplayRow[]; issues:string[]
  orderTrial?:TrialReport
  faqContrasts?:FaqContrastResult[]
}
export interface FeedbackCase {
  id:string; version:number; conversationId:string; messageId:string; question:string; originalAnswer:string; handoffReason:string
  reason:FeedbackReason; note:string; expected:FeedbackExpected; createdAt:number
  status:'new'|'draft'|'passed'|'blocked'|'published'; draft:FeedbackDraftInput|null; replay:FeedbackReplay|null
  draftVersion:number|null; publishedAt:number|null
}
