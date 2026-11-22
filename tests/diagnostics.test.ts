import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openStore } from '../server/store.ts'
import { createDiagnostics } from '../server/diagnostics.ts'
import { openCommerce } from '../server/commerce.ts'

function fixture(t: TestContext, liveCount = false, activeCommerce?: (id: string) => boolean) {
  const store = openStore(':memory:')
  const directory = mkdtempSync(join(tmpdir(), 'flow-diag-'))
  const logPath = join(directory, 'service.jsonl')
  writeFileSync(logPath, '')
  const generating = new Set<string>()
  const diagnostics = createDiagnostics(store, { logPath, activeAI: id => generating.has(id),
    activeCommerce,
    ...(liveCount ? { activeCount: () => generating.size } : {}),
    connections: () => ({ customers: 1, agents: 1 }), aiConfigured: () => true })
  function record(id: string, module: string, event: string, fields = {}) {
    appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), module, event, conversationId: id, ...fields }) + '\n')
  }
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { store, diagnostics, record, generating, logPath }
}

test('shop management reports real instance activity and never adds it to a selected customer trace', t => {
  const { store, diagnostics, logPath } = fixture(t)
  const session = store.create()
  const read = () => diagnostics.read({id: session.id})
  const shop = () => read().modules.find(m => m.id === 'merchant')
  assert.equal(shop()?.state, 'idle')
  for (const [event, status] of [['saved','已保存资料'], ['imported','已确认导入'], ['policy_trial','已完成试算'], ['policy_published','已发布政策']]) {
    appendFileSync(logPath, JSON.stringify({module:'merchant', event, at:'2026-11-21T08:00:00Z', orderId:'PRIVATE-ORDER', token:'PRIVATE-KEY', data:'PRIVATE-FACT'}) + '\n')
    const item = shop()
    assert.equal(item?.status, status)
    assert.equal(item.at, Date.parse('2026-11-21T08:00:00Z'))
    assert.match(item.detail, /店铺级/)
    assert.equal(JSON.stringify(read()).includes('PRIVATE'), false)
    assert.equal(read().selected?.events.some(e => e.module === 'merchant'), false)
    assert.equal(read().selected?.commerce.some(e => e.id === 'merchant'), false)
  }
  writeFileSync(logPath, 'invalid\n')
  assert.equal(shop()?.state, 'idle')
  rmSync(logPath)
  assert.equal(shop()?.state, 'unknown')
})

test('customer-confirmed AI resolution remains distinct from a staff claim after log rotation',t=>{
  const {store,diagnostics}=fixture(t)
  const {id}=store.create()
  store.append(id,'customer','咨询')
  store.append(id,'assistant','答复')
  assert.equal(store.resolve(id,store.snapshot(id)!.version,'customer'),'applied')
  const session=diagnostics.read({id}).selected!
  assert.equal(session.lifecycle?.at(-1)?.by,'customer')
  assert.ok(session.events.some(e=>e.label==='顾客确认已解决'))
  for(const id of ['queue','agent','reply']) assert.equal(session.stages.find(s=>s.id===id)?.state,'skipped')
})

test('shop map retains worksheet rows and the competing versions after a later successful operation', t => {
  const { diagnostics, store, record } = fixture(t)
  const id = store.create().id
  const read = () => diagnostics.read({id})
  const shop = () => read().modules.find(m => m.id === 'merchant')!
  record(id, 'merchant', 'import_preview_blocked', {sheet:'已售明细', rows:[6, 11], orderId:'PRIVATE-ORDER'})
  assert.equal(shop().state, 'blocked')
  assert.match(shop().recentBlocks![0].details.join(' '), /已售明细.*6.*11.*成交商品编码/)
  const conflict = {draft:{id:'RET-ACT-01', version:'V3'}, published:{id:'RET-ACT-01', version:'V2'},
    at:'2026-11-15 00:00:00', reason:'same_clause_start', rawText:'PRIVATE-TEXT'}
  record(id, 'merchant', 'policy_trial_blocked', {conflicts:[conflict], orderIds:['PRIVATE-ORDER']})
  assert.equal(shop().state, 'blocked')
  const details = shop().recentBlocks![0].details.join(' ')
  for (const fact of ['RET-ACT-01', 'V3', 'V2', '2026-11-15 00:00:00', '生效时刻相同']) assert.ok(details.includes(fact))
  record(id, 'merchant', 'policy_publish_blocked', {conflicts:[{...conflict, reason:'equal_priority_overlap',
    published:{id:'其他条款',version:'秋版'}}]})
  assert.match(shop().recentBlocks![0].details.join(' '), /其他条款.*秋版.*优先级/)
  record(id, 'merchant', 'saved')
  assert.equal(shop().state, 'ok')
  assert.deepEqual(shop().recentBlocks!.map(b => b.status), ['发布被拦截','试算发现冲突','导入预览被拦截'])
  assert.equal(JSON.stringify(read()).includes('PRIVATE'), false)
  assert.equal(read().selected?.events.some(e => e.module === 'merchant'), false)
})

test('diagnostics observes generation, failure and handoff without serializing messages or provider errors', t => {
  const { store, diagnostics, record, generating } = fixture(t)
  const session = store.create()
  record(session.id, 'session', 'created')
  store.append(session.id, 'customer', 'PRIVATE CUSTOMER BODY')
  record(session.id, 'ai', 'generation_started')
  generating.add(session.id)
  assert.equal(diagnostics.read({ id: session.id }).selected?.stages[1].state, 'active')
  generating.delete(session.id)
  record(session.id, 'ai', 'generation_failed', { kind: 'provider_http', statusCode: 429, error: 'PRIVATE PROVIDER ERROR' })
  store.setMode(session.id, 'ai', 'waiting')
  record(session.id, 'conversation', 'mode_changed', { mode: 'waiting', reason: 'ai_failure' })
  const failed = diagnostics.read({ id: session.id })
  assert.equal(failed.selected?.stages[1].state, 'failed')
  assert.equal(failed.selected?.stages[2].state, 'active')
  assert.match(failed.selected?.events.find(e => e.event === 'generation_failed')?.detail ?? '', /429/)
  assert.equal(failed.modules.find(m => m.id === 'ai')?.state, 'error')
  store.setMode(session.id, 'waiting', 'human')
  store.append(session.id, 'agent', 'PRIVATE AGENT BODY')
  const final = diagnostics.read({ search: session.id.slice(-6).toUpperCase() })
  assert.equal(final.selected?.id, session.id)
  assert.equal(final.selected?.stages[3].state, 'done')
  assert.equal(final.selected?.stages[4].state, 'done')
  assert.ok(final.selected?.events.some(e => e.event === 'agent_message'))
  for (const sensitive of ['PRIVATE', session.token]) assert.equal(JSON.stringify(final).includes(sensitive), false)
})

test('diagnostics distinguishes direct handoff from incomplete historical evidence and keeps an older selection', t => {
  const { store, diagnostics, record } = fixture(t)
  const direct = store.create()
  record(direct.id, 'session', 'created')
  store.setMode(direct.id, 'ai', 'waiting')
  record(direct.id, 'conversation', 'mode_changed', { mode:'waiting', reason:'customer_handoff' })
  assert.equal(diagnostics.read({ id: direct.id }).selected?.stages[1].state, 'skipped')
  const old = store.create()
  store.setMode(old.id, 'ai', 'waiting')
  for (let i = 0; i < 60; i++) store.create()
  const report = diagnostics.read({ id: old.id })
  assert.equal(report.sessions.length, 50)
  assert.equal(report.selected?.id, old.id)
  assert.equal(report.selected?.stages[1].state, 'unknown')
  assert.equal(report.selected?.stages[2].at, null)
  assert.equal(report.selected?.historyLimited, true)
  assert.equal(diagnostics.read({ search:'NO-MATCH' }).selected, null)
})

test('one finished request never hides a different running model request, even without readable logs', t => {
  const { store, diagnostics, record, generating, logPath } = fixture(t, true)
  const first = store.create()
  const second = store.create()
  generating.add(first.id)
  record(first.id, 'ai', 'generation_started')
  record(second.id, 'ai', 'generation_completed')
  assert.equal(diagnostics.read().modules.find(m => m.id === 'ai')?.state, 'active')
  rmSync(logPath)
  const missing = diagnostics.read()
  assert.equal(missing.evidence.logReadable, false)
  assert.equal(missing.modules.find(m => m.id === 'ai')?.state, 'active')
  generating.clear()
  assert.equal(diagnostics.read().modules.find(m => m.id === 'ai')?.state, 'idle')
})

test('diagnostic logs retain complete lines across polls and discard material from a replaced file', t => {
  const { store, diagnostics, record, logPath } = fixture(t)
  const session = store.create()
  record(session.id, 'session', 'created')
  const event = JSON.stringify({ at: new Date().toISOString(), conversationId: session.id, module: 'ai', event: 'generation_cancelled', reason: 'human_handoff' })
  appendFileSync(logPath, event.slice(0, -15))
  assert.equal(diagnostics.read({ id: session.id }).selected?.events.some(e => e.event === 'generation_cancelled'), false)
  appendFileSync(logPath, event.slice(-15) + '\n')
  assert.equal(diagnostics.read({ id: session.id }).selected?.events.filter(e => e.event === 'generation_cancelled').length, 1)
  assert.equal(diagnostics.read({ id: session.id }).selected?.events.filter(e => e.event === 'generation_cancelled').length, 1)
  writeFileSync(logPath, 'invalid record\n')
  const shortened = diagnostics.read({ id: session.id }).selected
  assert.equal(shortened?.historyLimited, true)
  assert.equal(shortened?.events.some(e => e.event === 'generation_cancelled'), false)
})

test('the selected business check shows its own rule version, and a later timeout clears the untouched nodes', t => {
  const { store, diagnostics, record } = fixture(t)
  const first = store.create()
  const second = store.create()
  for (const session of [first, second]) record(session.id, 'session', 'created')
  record(first.id, 'commerce', 'started')
  record(first.id, 'identity', 'verified', { elapsedMs: 0 })
  record(first.id, 'orders', 'found', { elapsedMs: 2, orderId: 'PRIVATE-ORDER' })
  record(first.id, 'policy', 'matched', { version: 'V1', elapsedMs: 3, account: 'PRIVATE-MEMBER' })
  record(first.id, 'eligibility', 'expired', { version: 'V1', elapsedMs: 1 })
  record(second.id, 'commerce', 'started')
  record(second.id, 'policy', 'matched', { version: 'V2' })
  const firstReport = diagnostics.read({ id: first.id })
  assert.match(firstReport.selected?.commerce?.find(m => m.id === 'policy')?.detail ?? '', /V1/)
  assert.match(firstReport.selected?.commerce?.find(m => m.id === 'policy')?.detail ?? '', /3 毫秒/)
  assert.equal(firstReport.selected?.commerce?.find(m => m.id === 'eligibility')?.state, 'ok')
  assert.match(firstReport.modules.find(m => m.id === 'policy')?.detail ?? '', /V2/)
  record(first.id, 'commerce', 'started')
  record(first.id, 'identity', 'verified', { elapsedMs: 1 })
  record(first.id, 'orders', 'timeout', { elapsedMs: 501, error: 'PRIVATE-ENDPOINT', version: 'PRIVATE' })
  record(first.id, 'orders', 'PRIVATE-ERROR-NAME')
  store.setMode(first.id, 'ai', 'waiting')
  record(first.id, 'conversation', 'mode_changed', { mode: 'waiting', reason: 'commerce_review' })
  const timedOut = diagnostics.read({ id: first.id })
  const current = timedOut.selected?.commerce
  assert.equal(current?.find(m => m.id === 'identity')?.state, 'ok')
  assert.equal(current?.find(m => m.id === 'orders')?.state, 'error')
  assert.match(current?.find(m => m.id === 'orders')?.detail ?? '', /超时.*501 毫秒/)
  for (const id of ['policy', 'eligibility']) assert.equal(current?.find(m => m.id === id)?.state, 'idle')
  assert.notEqual(timedOut.modules.find(m => m.id === 'ai')?.state, 'error')
  assert.match(timedOut.selected?.stages.find(s => s.id === 'queue')?.detail ?? '', /业务|人工核查/)
  assert.equal(timedOut.selected?.events.filter(e => e.module === 'orders' && e.failed).length, 1)
  assert.ok(!JSON.stringify(timedOut).includes('PRIVATE'))
})

test('missing evidence and an expected blocked lookup are distinct in business diagnostics', t => {
  const { store, diagnostics, record, logPath } = fixture(t)
  const session = store.create()
  record(session.id, 'session', 'created')
  record(session.id, 'commerce', 'started')
  record(session.id, 'identity', 'verified')
  record(session.id, 'orders', 'not_found')
  const result = diagnostics.read({ id: session.id })
  assert.equal(result.selected?.commerce?.find(m => m.id === 'orders')?.state, 'blocked')
  assert.equal(result.selected?.events.find(e => e.event === 'not_found')?.failed, false)
  rmSync(logPath)
  assert.equal(diagnostics.read({ id: session.id }).selected?.commerce?.find(m => m.id === 'orders')?.state, 'unknown')
})

test('an approved FAQ card carries its actual version and never counts as a model reply', async t => {
  const { store, diagnostics, record } = fixture(t)
  const session = store.create()
  const commerce = openCommerce(':memory:', { onTrace: (id, trace) =>
    record(id, trace.step, trace.code, { version: trace.version, elapsedMs: trace.elapsedMs }) })
  t.after(() => commerce.close())
  record(session.id, 'session', 'created')
  record(session.id, 'commerce', 'started')
  const { card } = await commerce.ask(session.id, {kind: 'faq', question: '退货怎么申请'})
  store.append(session.id, 'assistant', card.summary, { commerceCard: card })
  const selected = diagnostics.read({ id: session.id }).selected
  assert.match(selected?.commerce.find(m => m.id === 'policy')?.detail ?? '', /F1/)
  assert.equal(selected?.stages.find(s => s.id === 'ai')?.state, 'skipped')
  assert.ok(selected?.events.some(e => e.event === 'commerce_message' && e.stage === 'commerce'))
  assert.ok(!selected?.events.some(e => e.event === 'assistant_message'))
})

test('an order request started before handoff shows cancellation in the same session', t => {
  const { store, diagnostics, record } = fixture(t)
  const session = store.create()
  record(session.id, 'session', 'created')
  record(session.id, 'commerce', 'started')
  record(session.id, 'orders', 'lookup_started')
  const pending = diagnostics.read({ id: session.id }).selected?.commerce.find(m => m.id === 'orders')
  assert.equal(pending?.state, 'active')
  record(store.create().id, 'commerce', 'cancelled', { reason: 'human_handoff' })
  assert.equal(diagnostics.read({ id: session.id }).modules.find(m => m.id === 'orders')?.state, 'active')
  record(session.id, 'commerce', 'cancelled', { reason: 'human_handoff' })
  const ended = diagnostics.read({ id: session.id })
  for (const check of [ended.selected?.commerce, ended.modules]) {
    assert.equal(check?.find(m => m.id === 'orders')?.state, 'idle')
    assert.match(check?.find(m => m.id === 'orders')?.detail ?? '', /已中止/)
  }
  assert.ok(ended.selected?.events.some(e => e.event === 'cancelled' && e.stage === 'commerce'))
})

test('a lookup start from before a server restart does not leave a running badge', t => {
  const current = new Set<string>()
  const { store, diagnostics, record } = fixture(t, false, id => current.has(id))
  const session = store.create()
  record(session.id, 'session', 'created')
  record(session.id, 'commerce', 'started')
  record(session.id, 'orders', 'lookup_started')
  current.add(session.id)
  assert.equal(diagnostics.read({ id: session.id }).selected?.commerce.find(m => m.id === 'orders')?.state, 'active')
  current.clear()
  const report = diagnostics.read({ id: session.id })
  for (const checks of [report.modules, report.selected?.commerce]) {
    assert.equal(checks?.find(m => m.id === 'orders')?.state, 'unknown')
  }
})

test('feedback map traces only the linked case and draft, keeps replay failures and omits customer text', t => {
  const { store, diagnostics, record } = fixture(t)
  const first = store.create().id
  const other = store.create().id
  const evidence = { caseId: '00000000-0000-4000-8000-000000000012', revisionId: 21, target: 'faq', rawQuestion: 'PRIVATE-QUESTION' }
  const emit = (event: string, extra = {}) => record(first, 'feedback', event, { ...evidence, ...extra })
  emit('case_recorded', { revisionId: undefined, reasonCode: 'faq_wrong' })
  emit('revision_saved')
  emit('replay_failed', { passed: 1, total: 2, replayIssue: 'case_mismatch' })
  emit('publish_blocked', { blockReason: 'replay_failed' })
  const check = (id: string) => diagnostics.read({ id }).selected!.feedback!
  const node = (id: string) => check(first).find(m => m.id === id)!
  assert.match(node('feedback').detail, /问答.*有误/)
  assert.match(node('revision').detail, /案例 000012.*修订 21/)
  assert.match(node('replay').detail, /1\s*\/\s*2/)
  assert.equal(node('replay').state, 'blocked')
  assert.match(node('replay').detail, /预期不一致/)
  assert.match(node('publication').detail, /回放.*未通过/)
  record(other, 'feedback', 'case_recorded', { caseId: '00000000-0000-4000-8000-000000000099', reasonCode: 'PRIVATE-REASON' })
  assert.ok(check(other).filter(m => m.id !== 'feedback').every(m => m.state === 'idle'))
  assert.match(diagnostics.read({ id: first }).modules.find(m => m.id === 'feedback')!.detail, /案例 000099/)
  emit('revision_saved')
  assert.equal(node('replay').state, 'idle')
  assert.equal(node('publication').state, 'idle')
  assert.match(node('replay').recentBlocks![0].details.join(' '), /1\s*\/\s*2/)
  emit('replay_passed', { passed: 2, total: 2 })
  emit('publish_succeeded')
  assert.equal(node('publication').state, 'ok')
  assert.ok(!JSON.stringify(diagnostics.read({ id: first })).includes('PRIVATE'))
  emit('revision_saved', { revisionId: 24 })
  assert.equal(node('publication').state, 'idle')
  assert.match(node('replay').recentBlocks![0].details.join(' '), /修订 21/)
  emit('case_recorded', { caseId: '00000000-0000-4000-8000-000000000034', revisionId: undefined, reasonCode: 'missing_facts' })
  const session = diagnostics.read({ id: first }).selected!
  assert.match(session.feedback[0].detail, /案例 000034/)
  assert.equal(session.otherFeedback?.length, 1)
  assert.equal(session.otherFeedback[0].caseId, evidence.caseId)
  assert.match(session.otherFeedback[0].modules.find(m => m.id === 'publication')!.recentBlocks![0].details[0], /修订 21/)
})

test('a stale replay and a repeated publication show the committed state and retain the blocked attempt', t => {
  const { store, diagnostics, record } = fixture(t)
  const id = store.create().id
  const fields = { caseId: '00000000-0000-4000-8000-000000000123', revisionId: 2, target: 'policy' }
  const emit = (event: string, extra = {}) => record(id, 'feedback', event, { ...fields, ...extra })
  const state = (node: string) => diagnostics.read({id}).selected!.feedback.find(m => m.id === node)!
  emit('revision_saved')
  emit('replay_passed', { passed: 2, total: 2 })
  emit('publish_blocked', { blockReason: 'stale_replay' })
  assert.equal(state('replay').status, '需要重新回放')
  emit('replay_passed', { passed: 2, total: 2 })
  assert.equal(state('publication').state, 'idle')
  emit('publish_succeeded')
  emit('publish_blocked', { blockReason: 'already_published' })
  assert.equal(state('publication').state, 'ok')
  assert.equal(state('publication').recentBlocks!.length, 2)
})

test('policy replay identifies the affected case and keeps only typed deadline or version differences',t=>{
  const {store,diagnostics,record}=fixture(t)
  const id=store.create().id,caseId='00000000-0000-4000-8000-000000000051',related='00000000-0000-4000-8000-000000000052'
  const fields={caseId,revisionId:2,target:'policy',passed:1,total:2,replayIssue:'case_mismatch',policyMismatches:[
    {caseId:related,field:'deadline',expected:'2026-11-30 23:59:59',actual:'2026-11-29 23:59:59'},
    {caseId:related,field:'status',expected:'不应出现在日志中的文字',actual:'可申请退货'},
  ]}
  record(id,'feedback','replay_failed',fields)
  record(id,'feedback','publish_blocked',{...fields,blockReason:'replay_failed'})
  const nodes=diagnostics.read({id}).selected!.feedback
  for (const node of nodes.filter(m=>m.id==='replay'||m.id==='publication')) {
    assert.match(node.detail,/案例 000052.*截止时间.*预期 2026-11-30.*实际 2026-11-29/)
    assert.ok(!node.detail.includes('不应出现'))
    assert.equal(node.feedbackCaseId,caseId)
    assert.deepEqual(node.recentBlocks?.[0].feedbackCaseIds,[related])
  }
})
