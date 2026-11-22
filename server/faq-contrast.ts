import type { FaqContrastResult, FeedbackCase } from '../shared/feedback.ts'
import type { DemoFaq } from './commerce-fixtures.ts'
import { matchFaqs, normalizeQuestion } from './commerce-rules.ts'

// Retain previously published examples for this FAQ even when the next editor starts from a blank draft.
export function replayFaqContrasts(current:FeedbackCase, publishedCases:FeedbackCase[], faqs:DemoFaq[]):FaqContrastResult[] {
  const faqId = current.draft?.row.问答编号
  if (!faqId) return []
  const examples = new Map<string,string>()
  for (const entry of [...publishedCases, current]) {
    if (entry.id !== current.id && entry.status !== 'published') continue
    if (entry.draft?.kind !== 'faq' || entry.draft.row.问答编号 !== faqId) continue
    for (const question of entry.draft.contrastQuestions ?? []) examples.set(normalizeQuestion(question),question)
  }
  return [...examples.values()].map(question => {
    const hits = matchFaqs(question,faqs)
    return {question, excludedId:faqId, passed:!hits.some(faq=>faq.id===faqId),
      actual:hits.length ? hits.map(faq=>faq.id+' · '+faq.version).join('、') : '未命中已审核问答'}
  })
}
