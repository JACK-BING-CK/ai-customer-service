import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export async function acceptUpgrade({url, login, connect, send, receive}) {
  const [agent] = await connect({role:'agent'},'queue')
  const [debug] = await connect({role:'debug'},'diagnostics:ready')
  const run = randomUUID().slice(0,8).toUpperCase()
  const policyId = 'RET-DAYS-' + run
  const orderIds = ['DAYS-' + run + '-01','DAYS-' + run + '-02']
  const campaign = '收纳袋期限验收-' + run
  const sku = 'BAG-' + run
  const oldDeadline = '2026-11-23 23:59:59'
  const shortDeadline = '2026-11-29 23:59:59'
  const correctDeadline = '2026-11-30 23:59:59'

  async function post(path,body,expectedStatus=200) {
    const response = await fetch(url+'/api/'+path,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
    })
    const result = await response.json()
    assert.equal(response.status,expectedStatus,path + '：' + JSON.stringify(result))
    return result
  }
  async function customer(account='A') {
    const response = await login(account,account === 'A' ? '1111' : '2222')
    assert.equal(response.status,201)
    const session = await response.json()
    const [socket] = await connect({role:'customer',...session},'snapshot')
    return {id:session.id,socket}
  }
  async function ask(person,event,input) {
    const ready = receive(person.socket,'snapshot',s => !s.generating && !!s.messages.at(-1)?.commerceCard)
    await send(person.socket,event,{...input,requestId:randomUUID()})
    const snapshot = await ready
    return {snapshot,card:snapshot.messages.at(-1).commerceCard}
  }
  async function orderQuestion(person,id) {
    return ask(person,'customer:send',{text:'订单 ' + id + ' 可以退货吗？'})
  }
  async function claim(person) {
    const ready = receive(person.socket,'snapshot',s=>s.mode === 'human')
    await send(agent,'agent:claim',{id:person.id})
    return ready
  }
  async function answer(person,text) {
    const ready = receive(person.socket,'snapshot',s => s.messages.at(-1)?.text === text && s.messages.at(-1).role === 'agent')
    await send(agent,'agent:send',{id:person.id,text,requestId:randomUUID()})
    return ready
  }
  async function resolve(person,version) {
    const closed = receive(person.socket,'snapshot',s => s.mode === 'resolved')
    const removed = receive(agent,'queue',queue => !queue.some(s=>s.id === person.id))
    await send(agent,'agent:resolve',{id:person.id,version})
    await removed
    return closed
  }
  async function capture(person,consultation,status,version,deadline) {
    const original = consultation.snapshot.messages.at(-2)
    assert.equal(original.role,'customer')
    const {item} = await post('feedback/capture',{conversationId:person.id,messageId:original.id,
      reason:'policy_issue',expected:{kind:'policy',status,versions:[policyId+'@'+version],deadline}})
    assert.equal(item.originalAnswer,consultation.card.summary)
    return item
  }
  const map = async id => (await send(debug,'debug:read',{id})).report.selected
  async function step(item,action,body={}) {
    return (await post('feedback/'+item.id+'/'+action,{...body,expectedVersion:item.version})).item
  }

  const save = (kind,row) => post('merchant/save',{kind,row})
  await save('products',{'商品编码（SKU）':sku,商品名称:'旅行收纳袋',规格或型号:'中号',商品类别:'收纳',
    已确认的商品事实:'可折叠',事实来源:'模拟商品资料'})
  for (const [index,id] of orderIds.entries()) {
    await save('orders',{订单号:id,行号:'1',店铺会员编号:'A',成交商品编码:sku,成交商品与规格:'旅行收纳袋 · 中号',购买数量:'1',
      店铺:'山溪测试店',成交渠道:'店铺网页',成交活动:campaign,下单时间:index ? '2026-11-15 12:00:00' : '2026-11-12 12:00:00',
      物流状态:'已签收',签收时间:'2026-11-16 10:00:00',物流更新时间:'2026-11-16 10:00:00'})
  }
  const baseline = {条款编号:policyId,版本:'S1',名称:'收纳袋退货期限',适用店铺:'山溪测试店',渠道:'店铺网页',活动:campaign,
    '生效时间（含）':'2026-11-01 00:00:00','失效时间（不含）':'',按何时选版本:'下单时间',期限起算点:'签收次日算第 1 天',
    天数:'7',计时口径:'日历日／北京时间／含截止日',发布状态:'草稿',条款原文:'签收次日起7个日历日内可申请退货。'}
  await save('policies',baseline)
  const trialInput = {policyKey:policyId+'@S1',orderIds}
  const trial = await post('merchant/trial',trialInput)
  await post('merchant/publish',{...trialInput,token:trial.token})

  const old = await customer()
  const oldQuestion = await orderQuestion(old,orderIds[0])
  assert.equal(oldQuestion.card.deadline,oldDeadline)
  await send(old.socket,'customer:handoff',{})
  const oldClaim = await claim(old)
  const oldCase = await capture(old,oldQuestion,'expired','S1',oldDeadline)
  await resolve(old,oldClaim.version)

  const person = await customer()
  const first = await orderQuestion(person,orderIds[1])
  assert.equal(first.card.sources[0].version,'S1')
  assert.equal(first.card.deadline,oldDeadline)
  await send(person.socket,'customer:handoff',{})
  await claim(person)
  const firstReply = await answer(person,'已核对当前生效的 S1 条款，系统显示截至 11 月 23 日。')
  const closed = await resolve(person,firstReply.version)
  assert.deepEqual(closed.commerce.latestCard,first.card)
  const [archive,archived] = await connect({role:'agent',archive:true},'queue')
  assert.ok(archived.some(s => s.id === person.id && s.mode === 'resolved'))
  const openQueue = receive(agent,'queue',list=>list.some(s=>s.id===person.id && s.mode==='waiting'))
  const removedArchive = receive(archive,'queue',list=>!list.some(s=>s.id===person.id))
  const followup = '到底哪天截止？这次活动说可以退十四天。'
  await send(person.socket,'customer:send',{text:followup,requestId:randomUUID()})
  const ticket = (await openQueue).find(s=>s.id===person.id)
  await removedArchive
  assert.equal(ticket.messages.at(-1).text,followup)
  assert.deepEqual(ticket.commerce.latestCard,first.card)
  assert.deepEqual(ticket.messages.slice(0,-1),closed.messages)
  const lifecycle = (await map(person.id)).lifecycle
  assert.deepEqual(lifecycle.map(e=>e.kind),['resolved','reopened'])
  assert.ok(lifecycle[0].at > 0 && lifecycle[1].at >= lifecycle[0].at)
  await claim(person)

  let item = await capture(person,first,'eligible','S2',correctDeadline)
  const draft = days => ({...baseline,版本:'S2','生效时间（含）':'2026-11-15 00:00:00',天数:String(days),
    条款原文:'签收次日起'+days+'个日历日内可申请退货。'})
  item = await step(item,'draft',{kind:'policy',row:draft(13),orderIds})
  item = await step(item,'replay')
  const failed = item.replay.rows.find(row=>row.caseId === item.id)
  assert.equal(item.replay.passed,false)
  assert.equal(failed.checks.find(c=>c.field==='status').passed,true)
  assert.equal(failed.checks.find(c=>c.field==='versions').passed,true)
  assert.deepEqual(failed.checks.find(c=>c.field==='deadline'),{
    field:'deadline',expected:correctDeadline,actual:shortDeadline,passed:false,
  })
  await post('feedback/'+item.id+'/publish',{expectedVersion:item.version},409)
  const blocked = await map(person.id)
  const replayFailure = blocked.feedback.find(m=>m.id==='replay')
  assert.equal(replayFailure.state,'blocked')
  assert.equal(replayFailure.feedbackCaseId,item.id)
  assert.ok(replayFailure.detail.includes(correctDeadline) && replayFailure.detail.includes(shortDeadline))
  assert.equal(blocked.feedback.find(m=>m.id==='publication').state,'blocked')
  item = await step(item,'draft',{kind:'policy',row:draft(14),orderIds})
  item = await step(item,'replay')
  assert.ok(item.replay.passed,JSON.stringify(item.replay.issues))
  for (const id of [oldCase.id,item.id]) {
    const row = item.replay.rows.find(r => r.caseId===id)
    assert.ok(row.passed && row.checks.length===3 && row.checks.every(c=>c.passed))
  }
  assert.deepEqual(item.replay.orderTrial.results.map(r=>[r.orderId,r.before.version,r.after.version,r.after.status,r.after.deadline]),[
    [orderIds[0],'S1','S1','expired',oldDeadline],[orderIds[1],'S1','S2','eligible',correctDeadline],
  ])
  item = await step(item,'publish')
  assert.equal(item.status,'published')
  const check = await customer()
  for (const [i,id] of orderIds.entries()) {
    const {card} = await orderQuestion(check,id)
    assert.deepEqual([card.status,card.sources[0].id,card.sources[0].version,card.deadline],
      [i ? 'eligible' : 'expired',policyId,i ? 'S2' : 'S1',i ? correctDeadline : oldDeadline])
  }
  const final = await answer(person,'已按您的活动重新核对。适用 S2，从签收次日起算十四天，截止北京时间 11 月 30 日 23:59:59。')
  assert.deepEqual(final.commerce.latestCard,first.card,'历史依据卡应保存当时的结果')
  const fixed = await map(person.id)
  assert.deepEqual(fixed.lifecycle,lifecycle)
  assert.ok(fixed.feedback.every(m=>m.state==='ok'))
  assert.ok(fixed.feedback.find(m=>m.id==='replay').recentBlocks.some(b=>b.details.some(d=>d.includes(shortDeadline))))

  const {prepareLineDemo} = await import('./line-demo.mjs')
  await prepareLineDemo(url)
  const lines = await customer()
  const lineOrder = 'LINE-DEMO-100'
  const invalidLine = await ask(lines,'customer:commerce',{action:'return',orderId:lineOrder,line:2,quantity:4})
  assert.equal(invalidLine.card.status,'select_line')
  assert.equal(invalidLine.snapshot.mode,'ai')
  assert.equal(invalidLine.card.deadline,null)
  assert.equal((await map(lines.id)).commerce.find(m=>m.id==='orders').state,'blocked')
  const otherAccount = await customer('B')
  const inaccessible = await ask(otherAccount,'customer:commerce',{action:'return',orderId:lineOrder,line:2,quantity:1})
  const absent = await ask(otherAccount,'customer:commerce',{action:'return',orderId:'LINE-NO-SUCH-ORDER',line:2,quantity:1})
  assert.equal(inaccessible.card.status,'not_found')
  assert.deepEqual(inaccessible.card,absent.card)
  const lineCards = []
  for (const [line,sku,status,version,deadline] of [
    [1,'LINE-DEMO-CUP','eligible','RET-LINE-CUP','2026-11-30 23:59:59'],
    [2,'LINE-DEMO-COVER','expired','RET-LINE-COVER','2026-11-22 23:59:59'],
  ]) {
    const {card} = await ask(lines,'customer:commerce',{action:'return',orderId:lineOrder,line,quantity:2})
    assert.deepEqual([card.selectedLine.line,card.selectedLine.sku,card.selectedLine.quantity],[line,sku,2])
    assert.deepEqual([card.status,card.sources[0].id,card.sources[0].version,card.deadline],[status,version,'L1',deadline])
    lineCards.push(card)
  }
  const handoff = receive(agent,'queue',q=>q.some(s=>s.id===lines.id && s.mode==='waiting'))
  await send(lines.socket,'customer:handoff',{})
  assert.deepEqual((await handoff).find(s=>s.id===lines.id).commerce.latestCard,lineCards[1])
  const lineClaim = await claim(lines)
  await resolve(lines,lineClaim.version)
  const result = {conversationId:person.id,caseId:item.id,policyId,orderIds,oldDeadline,correctDeadline,
    lifecycle,lineConversationId:lines.id,lineOrder,debug:url+'/debug?conversation='+person.id}
  console.log('通过：原会话办结、查档、追问重开，13 天草稿因差一天被拦，14 天草稿通过。新旧单复问、按商品判定及交接依据均已核对。')
  console.log(JSON.stringify(result))
  return result
}
