import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'

// Runs against the isolated service started by accept-orders.mjs.
export async function acceptMerchant({url, login, connect, query, send, receive}) {
  const base = url + '/api/merchant'
  function post(path, body) {
    return fetch(base + path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)})
  }
  async function ok(res) {
    const body = await res.json()
    assert.ok(res.ok && body.ok, JSON.stringify(body.errors))
    return body
  }
  const template = await fetch(base + '/template')
  assert.ok(template.ok, '原模板可下载')
  const file = await template.arrayBuffer()
  const [debug] = await connect({role:'debug'},'diagnostics:ready')
  async function shopNode() {
    return (await send(debug, 'debug:read', {})).report.modules.find(m => m.id === 'merchant')
  }
  const wrongSku = XLSX.read(file, {type:'array'})
  const sold = wrongSku.Sheets['已售明细']
  sold.D6 = {t:'s',v:'PRIVATE-UNREGISTERED-SKU'}
  const invalid = await fetch(base + '/import/preview', {method:'POST',headers:{'Content-Type':'application/octet-stream'},
    body:XLSX.write(wrongSku,{bookType:'xlsx',type:'buffer'})})
  assert.equal(invalid.status, 422)
  const importNode = await shopNode()
  assert.equal(importNode.state, 'blocked', '错码预览应被模块地图标记为已拦截')
  assert.match(importNode.recentBlocks[0].details.join(' '), /已售明细.*第 6 行/)
  assert.doesNotMatch(JSON.stringify(importNode), /PRIVATE-UNREGISTERED-SKU/)

  const conflictInput = {policyKey:'RET-ACT-01@V3', orderIds:['DEMO-1001','DEMO-1002']}
  const conflictTrial = await ok(await post('/trial',conflictInput))
  assert.ok(conflictTrial.issues.length)
  assert.equal((await shopNode()).status,'试算发现冲突')
  assert.equal((await post('/publish',{...conflictInput,token:conflictTrial.token})).status,409)
  const blocked = await shopNode()
  assert.deepEqual(blocked.recentBlocks.map(b => b.status), ['发布被拦截','试算发现冲突','导入预览被拦截'])
  for (const block of blocked.recentBlocks.slice(0,2)) {
    for (const fact of ['RET-ACT-01 V3','RET-ACT-01 V2','2026-11-15 00:00:00']) assert.ok(block.details.join(' ').includes(fact))
  }
  const currentShop = await (await fetch(base)).json()
  assert.equal(currentShop.publications.includes(conflictInput.policyKey),false)
  assert.equal(currentShop.data.policies.find(r=>r['条款编号']==='RET-ACT-01' && r['版本']==='V3')['发布状态'],'草稿')
  console.log('通过：错码显示 Excel 工作表和行号，冲突试算与拒绝发布均保留两版本及其生效时刻。')
  function upload(stage, token) {
    return fetch(base + '/import/' + stage, {method:'POST', body:file, headers:{
      'Content-Type':'application/octet-stream', ...(token ? {'X-Import-Preview':token} : {}),
    }})
  }
  const preview = await ok(await upload('preview'))
  assert.deepEqual(preview.counts, {products:1,orders:2,policies:2,faqs:2})
  assert.equal((await upload('commit')).status,409)
  const detail = await (await fetch(base)).json()
  assert.equal(detail.data.products.some(r => r['商品编码（SKU）'] === 'QA-BOX'),false)
  const product = {...preview.samples.products[0], '商品编码（SKU）':'QA-BOX','商品名称':'验收收纳盒'}
  const save = (kind, row, original) => post('/save',{kind,row,original})
  await ok(await save('products',product))
  // A stale import preview must never silently overwrite a manual change.
  assert.equal((await upload('commit',preview.previewToken)).status,409)
  const fresh = await ok(await upload('preview'))
  await ok(await upload('commit', fresh.previewToken))
  const again = await ok(await upload('preview'))
  assert.equal(again.changes,0,'重复导入原模板应幂等')
  const revised = {...product,'规格或型号':'小号'}
  await ok(await save('products',revised,product))
  assert.equal((await save('products',{...product,'规格或型号':'中号'},product)).status,409)

  const activity = '独立验收活动'
  for (const [index, row] of preview.samples.orders.entries()) {
    await ok(await save('orders',{...row,'订单号':'QA-BOX-' + (index+1),'成交活动':activity,
      '成交商品编码':'QA-BOX','成交商品与规格':'验收收纳盒 · 小号'}))
  }
  const orderIds = ['QA-BOX-1','QA-BOX-2']
  const faq = {...preview.samples.faqs[0],'问答编号':'FAQ-QA-BOX','顾客常用问法':'收纳盒能装几支笔',
    '其他常见问法':'收纳盒的容量','标准答复':'可装六支笔。','依据或来源':'验收商品说明'}
  await ok(await save('faqs',faq))
  for (const row of preview.samples.policies) {
    await ok(await save('policies',{...row,'条款编号':'RET-QA-BOX','活动':activity,
      '失效时间（不含）':'','发布状态':'草稿','条款原文':row['条款原文'].replaceAll('秋季活动',activity)}))
  }
  const trial = policyKey => post('/trial',{policyKey,orderIds})
  const publish = (policyKey,token) => post('/publish',{policyKey,orderIds,token})
  const first = await ok(await trial('RET-QA-BOX@V1'))
  await ok(await publish('RET-QA-BOX@V1',first.token))
  const policyKey = 'RET-QA-BOX@V2'
  const second = await ok(await trial(policyKey))
  assert.deepEqual(second.results.map(r=>[r.before.version,r.after.version,r.after.status]),
    [['V1','V1','expired'],['V1','V2','eligible']])
  assert.equal(second.results[1].after.deadline,'2026-11-30 23:59:59')
  assert.equal((await publish(policyKey,'invalid')).ok,false)
  await ok(await publish(policyKey,second.token))
  const receipt = await (await fetch(base + '/publication?policyKey=' + encodeURIComponent(policyKey))).json()
  assert.deepEqual(receipt.results,second.results)
  assert.equal(receipt.token,undefined)
  console.log('通过：原模板预览、确认、重复导入，四类资料录入，过期预览与过期编辑保护，新旧单试算和发布。')

  const session = await (await login('A','1111')).json()
  const [customer, initial] = await connect({role:'customer',...session},'snapshot')
  assert.ok(initial.commerce.orders.some(order=>order.id===orderIds[1]))
  const [agent] = await connect({role:'agent'},'queue')
  const faqAnswer = receive(customer,'snapshot', s=>s.messages.at(-1)?.commerceCard?.kind === 'faq')
  await send(customer,'customer:send',{text:faq['顾客常用问法'],requestId:randomUUID()})
  assert.equal((await faqAnswer).messages.at(-1).commerceCard.summary,faq['标准答复'])
  const logistics = await query(customer,{action:'order',orderId:orderIds[0]},'found')
  assert.ok(logistics.facts.some(f=>f.value.includes('验收收纳盒')))
  const old = await query(customer,{action:'return', orderId:orderIds[0]},'expired')
  const current = await query(customer,{action:'return', orderId:orderIds[1]},'eligible')
  assert.equal(old.sources[0].version,'V1')
  assert.equal(current.sources[0].version,'V2')
  assert.equal(current.deadline,second.results[1].after.deadline)
  const queued = receive(agent,'queue', q => q.some(s=>s.id === session.id && s.mode === 'waiting'))
  await send(customer,'customer:handoff',{})
  assert.deepEqual((await queued).find(s=>s.id === session.id).commerce.latestCard,current)
  await send(agent,'agent:claim',{id:session.id})
  const reply = '我已核对本单 V2 条款、签收时间和申请截止日。'
  const delivered = receive(customer,'snapshot',s=>s.mode === 'human' && s.messages.at(-1)?.text === reply)
  await send(agent,'agent:send',{id:session.id,text:reply,requestId:randomUUID()})
  await delivered
  console.log('通过：顾客命中新增问答、查询已售订单并按版本判断，坐席收到完全相同的依据卡并在原窗口回复。')
}
