import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { ModuleMap } from '../client/ModuleMap'
import type { DiagnosticReport, ModuleStatus } from '../shared/diagnostics'
import type { TraceEvent, TracePage } from '../shared/trace'
import { TraceResults } from '../client/TraceExplorer'

const shop: ModuleStatus = {
  id: 'merchant', label: '店铺资料管理', state: 'blocked', status: '政策试算冲突',
  detail: 'RET-ACT-01 V2 与 RET-ACT-01 V3 同时生效。', at: 3000,
  recentBlocks: [
    { at: 3000, status: '政策试算冲突', details: ['RET-ACT-01 V2 与 RET-ACT-01 V3 同时生效。', '适用范围相同，发布后无法确定唯一版本。'] },
    { at: 2000, status: 'Excel 预览拦截', details: ['已售明细第 6 行：成交商品编码未登记。'] },
  ],
}

test('the routing node shows the archived and reopened timestamps from the same conversation', () => {
  const selected = {id:'00000000-0000-4000-8000-123456abcdef',mode:'waiting' as const,
    createdAt:1,updatedAt:3000,commerce:[],feedback:[],stages:[],events:[],historyLimited:false,
    lifecycle:[{kind:'resolved' as const,at:2000},{kind:'reopened' as const,at:3000}]}
  const report: DiagnosticReport = {selected,sessions:[selected],checkedAt:4000,modules:[],
    evidence:{requestAt:4000,logReadable:false,connections:{customers:1,agents:1,selectedCustomers:1,customerViews:1,agentViews:1,
      selectedCustomerViews:1,selectedAgentViews:1,lastViewAt:null}}}
  const html = renderToStaticMarkup(<ModuleMap report={report} />)
  expect(html).toMatch(/data-module-node="routing" aria-pressed="true"/)
  for (const text of ['重开待接单','坐席办结','顾客追问，原会话重开', new Date(2000).toISOString(),new Date(3000).toISOString()]) expect(html).toContain(text)
  expect(html).toContain('href="/debug?trace=TR-'+selected.id+'&amp;conversation='+selected.id+'"')
})

test('a step lookup keeps the identified step visible beside a page from a related order and other conversation', () => {
  const id = '00000000-0000-4000-8000-123456abcdef'
  const other = '00000000-0000-4000-8000-654321fedcba'
  const event:TraceEvent={sequence:5,id:'EV-'+id,conversationId:id,flowId:'TR-'+id,kind:'orders.lookup',
    at:5000,label:'核对本人订单',status:'ok',order:{shop:'演示店铺',owner:'A',orderId:'ORDER-01'},details:{code:'found'}}
  const page:TracePage={query:event.id,legacy:false,coverageSince:1000,matched:true,nextCursor:4,selectedEvent:event,
    events:[{...event,sequence:4,id:'EV-'+other,conversationId:other,flowId:'TR-'+other,at:4000}]}
  const html=renderToStaticMarkup(<TraceResults page={page}/>)
  for(const text of ['定位到的步骤','关联流程时间线',event.id,'EV-'+other,event.flowId!,'TR-'+other,
    '步骤编号','流程编号','ORDER-01','已找到','演示店铺','账号 A','查看会话模块地图']) expect(html).toContain(text)
  expect(html).toContain('href="/debug?trace=ORDER-01&amp;conversation='+id+'"')
  expect(html).toContain('复制步骤编号 '+event.id)
})

test('an older flow with partial evidence explains the coverage and can be distinguished from an unknown id', () => {
  const page:TracePage={query:'TR-historical',legacy:true,coverageSince:1000,matched:true,nextCursor:null,events:[]}
  const html=renderToStaticMarkup(<TraceResults page={page}/>)
  expect(html).toContain('此流程暂无可显示的步骤')
  expect(html).toContain('早期记录')
  expect(renderToStaticMarkup(<TraceResults page={{...page,matched:false,legacy:false}}/>)).toContain('没有找到对应记录')
})

test('a shop block shows the versions and earlier worksheet location together with their own times', () => {
  const report: DiagnosticReport = {
    selected: null, sessions: [], checkedAt: 4000, modules: [shop],
    evidence: { requestAt: 4000, logReadable: true, connections: {
      customers: 0, agents: 0, selectedCustomers: null, customerViews: 0, agentViews: 0,
      selectedCustomerViews: null, selectedAgentViews: null, lastViewAt: null,
    } },
  }
  const html = renderToStaticMarkup(<ModuleMap report={report} />)
  expect(html).toMatch(/data-module-node="merchant" aria-pressed="true"/)
  const details = html.slice(html.indexOf('aria-label="模块详情"'))
  expect(details).toContain('店铺级 · 全店操作')
  expect(details).toMatch(/政策试算冲突[\s\S]*1970-01-01T00:00:03.000Z[\s\S]*RET-ACT-01 V2 与 RET-ACT-01 V3[\s\S]*无法确定唯一版本[\s\S]*Excel 预览拦截[\s\S]*1970-01-01T00:00:02.000Z[\s\S]*已售明细第 6 行/)
  expect(details.match(/RET-ACT-01 V2 与 RET-ACT-01 V3/g)).toHaveLength(1)
})

test('a selected order timeout is visible and focused even after a successful lookup in a different session', () => {
  const timeout: ModuleStatus = { id: 'orders', label: '订单查询', status: '查询超时', detail: '所选会话查询超时。', state: 'error', at: 1 }
  const report: DiagnosticReport = {
    sessions: [], checkedAt: 2, evidence: { requestAt: 2, logReadable: true, connections: {
      customers: 0, agents: 0, selectedCustomers: 0, customerViews: 0, agentViews: 0,
      selectedCustomerViews: 0, selectedAgentViews: 0, lastViewAt: null,
    } },
    selected: { id: '00000000-0000-4000-8000-123456abcdef', mode: 'waiting', createdAt: 1, updatedAt: 2,
      stages: [], events: [], historyLimited: false, commerce: [timeout], feedback: [] },
    modules: [shop, { ...timeout, status: '已查到订单', detail: '另一个会话查单成功。', state: 'ok', at: 2 }],
  }
  const html = renderToStaticMarkup(<ModuleMap report={report} />)
  expect(html).toContain('data-module-node="merchant"')
  expect(html).toContain('店铺级')
  expect(html).toContain('提供商品与订单')
  expect(html).toContain('提供条款与问答')
  expect(html).toMatch(/data-module-node="orders" aria-pressed="true"/)
  expect(html).toContain('所选会话查询超时。')
  expect(html).toContain('ABCDEF')
  expect(html).not.toContain('另一个会话查单成功。')
  expect(html).not.toContain('已售明细第 6 行')
})

test('the feedback route connects the agent to the shop and highlights a replay blocked in the selected case', () => {
  const replay: ModuleStatus = { id: 'replay', label: '历史回放', state: 'blocked', status: '回放未通过',
    detail: '案例 123456 · 修订 2。历史案例通过 0 / 1。', at: 3,feedbackCaseId:'00000000-0000-4000-8000-000000123456' }
  const report: DiagnosticReport = {
    sessions: [], checkedAt: 4, selected: { id: '00000000-0000-4000-8000-123456abcdef', mode: 'human', createdAt: 0,
      updatedAt: 3, stages: [], events: [], historyLimited: false, commerce: [], feedback: [replay] },
    modules: [shop, { ...replay, state: 'ok', status: '回放通过', detail: '其他案例', at: 4 }],
    evidence: { requestAt: 4, logReadable: true, connections: { customers: 0, agents: 0, selectedCustomers: null,
      customerViews: 0, agentViews: 0, selectedCustomerViews: null, selectedAgentViews: null, lastViewAt: null } },
  }
  const html = renderToStaticMarkup(<ModuleMap report={report} />)
  for (const label of ['坐席反馈', '运营修订', '历史回放', '修订发布', '本会话反馈', '全店最近反馈']) expect(html).toContain(label)
  expect(html).toMatch(/data-module-node="replay" aria-pressed="true"/)
  expect(html).toContain('案例 123456 · 修订 2')
  expect(html).toContain('/merchant?case=00000000-0000-4000-8000-000000123456#feedback')
  expect(html).not.toContain('其他案例')
})
