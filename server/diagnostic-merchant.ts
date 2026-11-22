import type { ShopBlock } from '../shared/diagnostics.ts'
import { describePolicyConflict } from '../shared/merchant.ts'

export interface ShopActivity {
  at: number
  status: string
  detail: string
  block?: ShopBlock
}

const successful = new Map([
  ['saved', '已保存资料'], ['imported', '已确认导入'], ['policy_trial', '已完成试算'], ['policy_published', '已发布政策'],
])
const categories = new Map<string, string>([['products', '商品资料'], ['orders', '已售订单'], ['policies', '政策版本'], ['faqs', '常见问答']])

function policyRef(value: unknown) {
  if (!value || typeof value !== 'object' || !('id' in value) || !('version' in value)) return
  const valid = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64 && !/[@\s\p{Cc}]/u.test(id)
  if (valid(value.id) && valid(value.version)) return {id:value.id, version:value.version}
}

function conflictDetail(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('draft' in value) || !('published' in value) ||
      !('reason' in value) || !('at' in value)) return
  const draft = policyRef(value.draft), published = policyRef(value.published)
  if (!draft || !published || typeof value.at !== 'string' || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value.at)) return
  if (value.reason !== 'same_clause_start' && value.reason !== 'equal_priority_overlap') return
  return describePolicyConflict({draft, published, at:value.at, reason:value.reason})
}

// Describe only known outcomes and their typed evidence. Workbook cells, input filenames,
// trial orders and raw exception text have no place in the debug map.
export function shopActivity(raw: Record<string, unknown>, at: number): ShopActivity | undefined {
  if (typeof raw.event !== 'string') return
  const success = successful.get(raw.event)
  if (success) {
    const category = raw.event === 'saved' && typeof raw.category === 'string' ? categories.get(raw.category) : undefined
    const changes = (raw.event === 'saved' || raw.event === 'imported') && typeof raw.changes === 'number' && Number.isSafeInteger(raw.changes) && raw.changes >= 0
      ? `，本次变更 ${raw.changes} 条` : ''
    return { at, status:success, detail:`店铺级最近操作为「${success}」${category ? '（' + category + '）' : ''}${changes}。` }
  }
  let status: string, detail: string, details: string[]
  if (raw.event === 'import_preview_blocked' || raw.event === 'import_commit_blocked') {
    status = raw.event === 'import_preview_blocked' ? '导入预览被拦截' : '确认导入被拦截'
    detail = 'Excel 校验未通过，本次导入写入 0 条。'
    const rows = raw.sheet === '已售明细' && Array.isArray(raw.rows)
      ? raw.rows.filter((n): n is number => Number.isInteger(n) && n >= 5 && n <= 1048576) : []
    details = []
    // Group long lists while retaining every physical worksheet row number.
    for (let start = 0; start < rows.length; start += 12) {
      details.push('已售明细 · 第 ' + rows.slice(start, start + 12).join('、') + ' 行：成交商品编码未登记。')
    }
    if (!details.length) details.push('请在店铺资料管理的导入预览中核对文件校验提示。')
  } else if (raw.event === 'policy_trial_blocked' || raw.event === 'policy_publish_blocked') {
    status = raw.event === 'policy_trial_blocked' ? '试算发现冲突' : '发布被拦截'
    detail = '政策无法唯一选版，已阻止发布，草稿仍未生效。'
    details = (Array.isArray(raw.conflicts) ? raw.conflicts : []).map(conflictDetail).filter((s): s is string => !!s)
    if (typeof raw.conflictCount === 'number' && Number.isSafeInteger(raw.conflictCount) && raw.conflictCount > details.length)
      details.push(`本次共有 ${raw.conflictCount} 对冲突，此处列出 ${details.length} 对。`)
    if (!details.length) details.push('试算发现规则重叠，请在店铺资料管理中重新试算并核对版本。')
  } else return
  return {at, status, detail, block:{at, status, details}}
}
