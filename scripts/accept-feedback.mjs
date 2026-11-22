import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

// Public customer/seat channels and operator endpoints, against the isolated demo shop.
export async function acceptFeedback({url, login, connect, send, receive}) {
  const [agent] = await connect({role:'agent'},'queue')
  const [debug] = await connect({role:'debug'},'diagnostics:ready')
  const post = (path,body) => fetch(url + '/api/' + path, {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
  })
  async function result(path,body) {
    const reply = await post(path,body)
    const data = await reply.json()
    assert.ok(reply.ok, JSON.stringify(data))
    return data
  }
  async function ask(question) {
    const session = await (await login('A','1111')).json()
    const [customer] = await connect({role:'customer',...session},'snapshot')
    const completed = receive(customer,'snapshot',s=>!!s.messages.at(-1)?.commerceCard)
    await send(customer,'customer:send',{text:question,requestId:randomUUID()})
    const state = await completed
    return {customer,session,state,card:state.messages.at(-1).commerceCard}
  }
  async function capture(example, reason, expected) {
    const {customer,session,state} = example
    if (state.mode !== 'waiting') await send(customer,'customer:handoff',{})
    await send(agent,'agent:claim',{id:session.id})
    const input = {conversationId:session.id,messageId:state.messages.find(m=>m.role === 'customer').id,reason,expected}
    const item = (await result('feedback/capture',input)).item
    assert.equal(item.originalAnswer,example.card.summary)
    return item
  }
  const act = async (c,op,body={}) => (await result('feedback/' + c.id + '/' + op,{...body,expectedVersion:c.version})).item
  const viewMap = async id => (await send(debug,'debug:read',{id})).report.selected.feedback
  const question = '杯盖密封圈补寄的运费由谁承担？'
  const answer = '模拟店铺承担首次补寄密封圈的普通快递运费。'
  const first = await ask(question)
  assert.equal(first.card.status,'review')
  assert.equal(first.state.mode,'waiting')
  let faq = await capture(first,'faq_gap',{kind:'faq',answer})
  const row = {问答编号:'FAQ-SEAL',版本:'F1',顾客常用问法:question,其他常见问法:'',标准答复:'顾客承担运费。',依据或来源:'模拟店铺补寄说明',状态:'草稿'}
  faq = await act(faq,'draft',{kind:'faq',row})
  faq = await act(faq,'replay')
  assert.equal(faq.replay.passed,false)
  assert.equal((await post('feedback/' + faq.id + '/publish',{expectedVersion:faq.version})).status,409)
  const blocked = await viewMap(first.session.id)
  assert.equal(blocked.find(n=>n.id === 'replay').state,'blocked')
  assert.equal(blocked.find(n=>n.id === 'publication').state,'blocked')
  faq = await act(faq,'draft',{kind:'faq',row:{...row,标准答复:answer}})
  faq = await act(faq,'replay')
  assert.equal(faq.replay.passed,true)
  assert.equal((await ask(question)).card.status,'review','草稿回放不能影响顾客')
  faq = await act(faq,'publish')
  const live = await ask(question)
  assert.equal(live.card.summary,answer)
  assert.equal(live.card.sources[0].id,'FAQ-SEAL')
  assert.equal(live.state.mode,'ai')
  assert.equal(faq.status,'published')
  const success = await viewMap(first.session.id)
  assert.ok(success.every(n=>n.state === 'ok'))
  assert.doesNotMatch(JSON.stringify(success),/密封圈|顾客承担运费/)
  console.log('通过：缺失问答转人工，错误草稿回放失败并阻止发布；正确草稿通过，同一问题在新会话引用已发布答复。')

  const paraphrase = '密封圈补发谁付邮费？'
  const counterexample = '整个杯子退货谁付邮费？'
  const returnFee = '整杯退货的运费按退货原因核定，请先提供退货原因。'
  await result('merchant/save',{kind:'faqs',row:{...row,问答编号:'FAQ-CUP-RETURN',顾客常用问法:counterexample,标准答复:returnFee,状态:'已审核'}})
  const missed = await ask(paraphrase)
  assert.equal(missed.card.status,'review')
  let aliasCase = await capture(missed,'faq_gap',{kind:'faq',answer})
  const revision = {...row,版本:'F2',标准答复:answer,其他常见问法:paraphrase+'／'+counterexample}
  aliasCase = await act(aliasCase,'draft',{kind:'faq',row:revision,contrastQuestions:[counterexample]})
  aliasCase = await act(aliasCase,'replay')
  assert.equal(aliasCase.replay.faqContrasts[0].passed,false,'易混淆的问法被错误归到补寄时应拦截')
  assert.equal((await post('feedback/'+aliasCase.id+'/publish',{expectedVersion:aliasCase.version})).status,409)
  aliasCase = await act(aliasCase,'draft',{kind:'faq',row:{...revision,其他常见问法:paraphrase},contrastQuestions:[counterexample]})
  aliasCase = await act(aliasCase,'replay')
  assert.equal(aliasCase.replay.faqContrasts[0].passed,true)
  assert.match(aliasCase.replay.faqContrasts[0].actual,/FAQ-CUP-RETURN/)
  await act(aliasCase,'publish')
  assert.equal((await ask(paraphrase)).card.summary,answer)
  assert.equal((await ask(counterexample)).card.summary,returnFee)
  console.log('通过：坐席原话加入已有问答；错误收录反例拦发布，改正后补寄邮费和整杯退货邮费分别引用各自的已审核答复。')

  const campaign = '反馈回放体验周'
  const save = (kind,row) => result('merchant/save',{kind,row})
  await save('products',{'商品编码（SKU）':'TRIAL-SEAL',商品名称:'密封杯',规格或型号:'蓝色',商品类别:'杯具',已确认的商品事实:'模拟商品',事实来源:'模拟商品手册'})
  const orderIds = ['FEED-1101','FEED-1102']
  const shop = '山溪测试店', channel = '店铺网页'
  for (const [i,orderId] of orderIds.entries()) {
    await save('orders',{订单号:orderId,行号:'1',店铺会员编号:'A',成交商品编码:'TRIAL-SEAL',成交商品与规格:'蓝色密封杯',购买数量:'1',
      店铺:shop,成交渠道:channel,成交活动:campaign,下单时间:i ? '2026-11-15 12:00:00' : '2026-11-12 12:00:00',
      物流状态:'已签收',签收时间:'2026-11-16 10:00:00',物流更新时间:'2026-11-16 10:00:00'})
  }
  const policy = {条款编号:'RET-REPLAY',版本:'R1',名称:'密封杯退货期限',适用店铺:shop,渠道:channel,活动:campaign,
    '生效时间（含）':'2026-11-01 00:00:00','失效时间（不含）':'',按何时选版本:'下单时间',期限起算点:'签收次日算第 1 天',
    天数:'7',计时口径:'日历日／北京时间／含截止日',发布状态:'草稿',条款原文:'签收次日起7个日历日内可申请退货。'}
  await save('policies',policy)
  const trialInput = {policyKey:'RET-REPLAY@R1',orderIds}
  const trial = await result('merchant/trial',trialInput)
  await result('merchant/publish',{...trialInput,token:trial.token})
  const policyQuestion = id => '订单 ' + id + ' 可以退货吗？'
  const oldOrder = await ask(policyQuestion(orderIds[0]))
  await capture(oldOrder,'customer_request',{kind:'policy',status:'expired',versions:['RET-REPLAY@R1'],deadline:'2026-11-23 23:59:59'})
  const newOrder = await ask(policyQuestion(orderIds[1]))
  assert.equal(newOrder.card.status,'expired')
  let change = await capture(newOrder,'policy_issue',{kind:'policy',status:'eligible',versions:['RET-REPLAY@R2'],deadline:'2026-11-30 23:59:59'})
  const next = {...policy,版本:'R2','生效时间（含）':'2026-11-15 00:00:00',天数:'14',条款原文:'签收次日起14个日历日内可申请退货。'}
  change = await act(change,'draft',{kind:'policy',row:next,orderIds})
  change = await act(change,'replay')
  assert.ok(change.replay.passed,JSON.stringify(change.replay))
  assert.deepEqual(change.replay.orderTrial?.results.map(r=>[r.orderId,r.before.version,r.after.version]),[
    [orderIds[0],'R1','R1'],[orderIds[1],'R1','R2'],
  ])
  assert.deepEqual(Object.keys(change.replay.orderTrial).sort(),['asOf','issues','results'])
  assert.ok(change.replay.rows.some(r=>r.caseId !== change.id && r.question.includes(orderIds[0]) && r.passed))
  await act(change,'publish')
  assert.equal((await ask(policyQuestion(orderIds[0]))).card.sources[0].version,'R1')
  const corrected = await ask(policyQuestion(orderIds[1]))
  assert.equal(corrected.card.status,'eligible')
  assert.equal(corrected.card.sources[0].version,'R2')
  assert.equal(corrected.card.deadline,'2026-11-30 23:59:59')
  assert.ok((await viewMap(newOrder.session.id)).every(node=>node.state === 'ok'))
  console.log('通过：政策修订沿用两单试算，回放历史新旧咨询，发布后旧单继续适用 R1，新单按 R2 延长到 11 月 30 日。')
}
