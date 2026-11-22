import type { BusinessModuleId, ModuleStatus } from '../shared/diagnostics.ts'
import type { TraceEntry } from './diagnostic-log.ts'

const labels: Record<BusinessModuleId, string> = {
  identity: '身份核验', orders: '订单查询', policy: '条款检索', eligibility: '资格判断',
}
type Result = [ModuleStatus['state'], string, string]
const results: Record<BusinessModuleId, Record<string, Result>> = {
  identity: {
    verified: ['ok', '已核验', '服务端已核验本会话的测试身份。'],
    login_required: ['blocked', '待登录', '查询本人订单前需要登录。'],
    invalid_login: ['blocked', '核验未通过', '登录信息未通过核验。'],
    account_locked: ['blocked', '账号不匹配', '此会话已绑定另一个账号。'],
  },
  orders: {
    lookup_started: ['active', '查询已发起', '只读订单接口已收到查询，尚无完成记录。'],
    found: ['ok', '已查到订单', '已在当前账号范围内读取模拟订单。'],
    line_found: ['ok', '已核验指定商品行', '已核验订单归属、商品行及申请数量，按该行的成交活动和签收记录判断。'],
    invalid_line: ['blocked', '商品行或数量无效', '指定行不存在或退货数量超出该行的购买范围，请顾客重新选择。'],
    select_line: ['blocked', '待选择商品', '顾客询问部分退货，需要确认具体商品行和数量。'],
    not_found: ['blocked', '未查到订单', '当前账号没有可展示的匹配订单。'],
    timeout: ['error', '查询超时', '只读订单接口超时。'],
  },
  policy: {
    matched: ['ok', '已命中条款', '已定位适用的已发布条款。'],
    missing_policy: ['blocked', '缺少条款', '没有找到适用的已发布条款，需要人工核查。'],
    conflict: ['error', '条款冲突', '多条同优先级条款同时适用，需要人工核查。'],
    line_review: ['blocked', '按订单行核对', '不同商品行涉及多个活动，需要按行确认。'],
  },
  eligibility: {
    eligible: ['ok', '可申请', '规则计算完成，当前在退货申请期限内。'],
    expired: ['ok', '已过期限', '规则计算完成，当前已超过退货申请期限。'],
    missing_fact: ['blocked', '事实待核实', '缺少计算期限所需的订单事实，需要人工核查。'],
    condition_review: ['blocked', '办理条件待核实', '已按结构化时限试算，条款原文中的完整办理条件需要人工核查。'],
    line_review: ['blocked', '订单明细待核实', '订单行的活动或签收情况不一致，需确定待退商品行。'],
    missing_policy: ['blocked', '缺少依据', '缺少适用条款，无法确定资格。'],
    conflict: ['blocked', '待人工核查', '适用条款冲突，无法确定资格。'],
  },
}

function matchResult(module: BusinessModuleId, code: string): Result | undefined {
  if (code === 'error') return ['error', '执行失败', labels[module] + '发生错误，请核查此模块。']
  return Object.hasOwn(results[module], code) ? results[module][code] : undefined
}

// Produce display text only from supported business outcomes and validated scalar metadata.
export function businessEvent(module: string, code: string, elapsedMs: unknown, version: unknown) {
  if (!Object.hasOwn(labels, module)) return
  const result = matchResult(module as BusinessModuleId, code)
  if (!result) return
  const [state, status, message] = result
  const parts = [message]
  if ((module === 'eligibility' || module === 'policy') && typeof version === 'string' && /^(?:V|F|CO)[1-9]\d{0,3}$/.test(version)) {
    parts.push('版本 ' + version + '。')
  }
  if (typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < 86_400_000) {
    parts.push('耗时 ' + Math.round(elapsedMs) + ' 毫秒。')
  }
  return { label: labels[module as BusinessModuleId] + ' · ' + status, detail: parts.join(' '), failed: state === 'error' }
}

export function businessModules(entries: TraceEntry[], logReadable: boolean, scope: 'instance' | 'session', coverage: boolean,
  activeCommerce?: (id: string) => boolean): ModuleStatus[] {
  const current = scope === 'session' ? entries.slice(entries.findLastIndex(e => e.module === 'commerce' && e.event === 'started') + 1) : entries
  return (Object.keys(labels) as BusinessModuleId[]).map(id => {
    const label = labels[id]
    const last = current.findLastIndex(e => e.module === id)
    const latest = current[last]
    if (latest) {
      if (latest.event === 'lookup_started') {
        const stopped = current.slice(last + 1).find(e => e.conversationId === latest.conversationId && e.module === 'commerce' &&
          (e.event === 'cancelled' || e.event === 'failed' || e.event === 'generation_persistence_failed'))
        if (stopped?.event === 'cancelled') return { id, label, state: 'idle', status: '查询已中止',
          detail: '订单查询已中止。' + stopped.detail, at: stopped.at }
        if (stopped || activeCommerce?.(latest.conversationId) === false) return { id, label, state: 'unknown', status: '缺少结果',
          detail: '已记录订单查询开始与当前操作结束，缺少订单接口的返回结果。', at: stopped?.at ?? latest.at }
      }
      const [state, status] = matchResult(id, latest.event)!
      return { id, label, state, status, detail: latest.detail, at: latest.at }
    }
    const insufficient = !logReadable || (scope === 'session' && !coverage)
    return { id, label, state: insufficient ? 'unknown' : 'idle',
      status: insufficient ? '记录不足' : scope === 'session' ? '暂无调用' : '近期无记录',
      detail: !logReadable ? '服务端运行日志暂不可读取。' : scope === 'session' ? '此会话当前查询尚无该步骤的运行记录。' : '近期日志中没有此模块的运行记录。', at: null }
  })
}
