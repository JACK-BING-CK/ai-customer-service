import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { openCommerce } from '../server/commerce.ts'
import { openMerchant } from '../server/merchant-store.ts'
import { merchantTemplatePath, parseMerchantWorkbook } from '../server/merchant-xlsx.ts'

function setup() {
  const db = new DatabaseSync(':memory:')
  const commerce = openCommerce(db)
  const merchant = openMerchant(db)
  const seed = merchant.list()
  const product = { '商品编码（SKU）':'TEST-450', 商品名称:'旅行杯', '规格或型号':'450 mL', 商品类别:'杯', 已确认的商品事实:'容量 450 mL', 事实来源:'规格书' }
  const order = { ...seed.orders.find(r => r.订单号 === 'DEMO-1002')!, 订单号:'SHOP-101', 成交商品编码:'TEST-450', 成交商品与规格:'旅行杯 · 450 mL', 下单时间:'2026-11-15 12:00:00' }
  const draft = { ...seed.policies.find(r => r.版本 === 'V1')!, 版本:'V4', '生效时间（含）':order.下单时间, '失效时间（不含）':'', 天数:'21', 条款原文:'签收次日起21个日历日内可申请退货。' }
  return { db, commerce, merchant, product, order, draft }
}

test('merchant writes are atomic, preview is read-only, references and historical facts are checked', () => {
  const {db, merchant, product, order} = setup()
  try {
    const invalid = merchant.apply({products:[product],orders:[{...order, 成交商品编码:'UNKNOWN'}]}, true)
    assert.equal(invalid.ok, false)
    assert.equal(merchant.list().products.length, 0)
    const rows = {products:[product], orders:[order,{...order,行号:'2',购买数量:'3'}]}
    assert.equal(merchant.apply(rows,false).changes,3)
    assert.equal(merchant.list().products.length, 0)
    assert.equal(merchant.apply(rows,true).changes,3)
    assert.equal(merchant.apply(rows,true).changes,0)
    assert.equal(merchant.apply({orders:[{...order,店铺会员编号:'B'}]},true).ok,false)
    assert.equal(merchant.apply({orders:[{...order,购买数量:'9'}]},true).ok,false)
    assert.equal(merchant.list().orders.filter(r=>r.订单号==='SHOP-101').length,2)
  } finally {db.close()}
})

test('published simulation uses identical clock and facts as customer and preserves old policy quotes', async () => {
  const {db,commerce,merchant,product,order,draft} = setup()
  try {
    assert.equal(merchant.apply({products:[product],orders:[order],policies:[draft]},true).ok,true)
    assert.equal(merchant.list().policies.find(r=>r.版本==='V4')!.发布状态,'草稿')
    const ids = ['DEMO-1001','SHOP-101']
    const trial = merchant.trial('RET-ACT-01@V4',ids)
    assert.deepEqual(trial.results.map(r=>r.after.version), ['V1','V4'])
    const revise = {...draft,天数:'20',条款原文:'签收次日起20个日历日内可申请退货。'}
    assert.equal(merchant.apply({policies:[revise]},true).ok,true)
    assert.throws(()=>merchant.publish('RET-ACT-01@V4',ids,trial.token))
    const valid = merchant.trial('RET-ACT-01@V4',ids)
    merchant.publish('RET-ACT-01@V4',ids,valid.token)
    assert.ok(merchant.publicationKeys().includes('RET-ACT-01@V4'))
    assert.deepEqual(Object.keys(merchant.publication('RET-ACT-01@V4')!).sort(),['asOf','issues','results'])
    assert.deepEqual(merchant.publication('RET-ACT-01@V4')?.results,valid.results)
    assert.equal(merchant.apply({policies:[{...revise,条款原文:'覆盖已发布原文'}]},true).ok,false)
    assert.equal(merchant.apply({policies:[revise]},true).changes,0)
    commerce.login('a','A','1111')
    for(const [i, orderId] of ids.entries()) {
      const {card} = await commerce.ask('a',{kind:'return',orderId})
      assert.deepEqual([card.sources[0].version,card.status,card.reason,card.deadline], [valid.results[i].after.version,valid.results[i].after.status,valid.results[i].after.reason,valid.results[i].after.deadline])
    }
    const {card}=await commerce.ask('a',{kind:'order',orderId:ids[1]})
    assert.match(JSON.stringify(card.facts),/450 mL/)
    assert.match(JSON.stringify(card.facts),/规格书/)
  } finally {db.close()}
})

test('additional conditions require manual review and approved merchant FAQ reaches the conversation router', async () => {
  const {db,commerce,merchant,product,order,draft} = setup()
  try {
    draft.条款原文 += '已拆封不得退货。'
    const faq = {问答编号:'CAP',版本:'F1',顾客常用问法:'这个杯子多大？',其他常见问法:'容量是多少？',标准答复:'450 mL。',依据或来源:'规格书',状态:'已审核'}
    assert.equal(merchant.apply({products:[product],orders:[order],policies:[draft],faqs:[faq]},true).ok,true)
    const ids = ['DEMO-1001','SHOP-101']
    const trial = merchant.trial('RET-ACT-01@V4',ids)
    assert.equal(trial.results[1].after.status,'review')
    merchant.publish('RET-ACT-01@V4',ids,trial.token)
    commerce.login('a','A','1111')
    const {card,handoff} = await commerce.ask('a',{kind:'return',orderId:'SHOP-101'})
    assert.ok(handoff)
    assert.match(card.sources[0].text,/已拆封/)
    assert.equal(commerce.parseQuery('请问，容量是多少？')?.kind,'faq')
    const answer=await commerce.ask('a',{kind:'faq',question:'容量是多少？'})
    assert.equal(answer.card.summary,faq.标准答复)
    assert.match(JSON.stringify(answer.card),/规格书/)
  } finally {db.close()}
})

test('original workbook enriches both historical orders, preserves existing texts and imports idempotently', async () => {
  const {db,commerce,merchant} = setup()
  try {
    const rows = await parseMerchantWorkbook(await readFile(merchantTemplatePath))
    const before=merchant.list()
    assert.ok(merchant.apply(rows,false).ok)
    assert.deepEqual(merchant.list(),before)
    const saved=merchant.apply(rows,true)
    assert.equal(saved.ok,true,JSON.stringify(saved.errors))
    assert.match(saved.warnings.join(' '),/常见问答.*第 5 行/)
    assert.equal(merchant.apply(rows,true).changes,0)
    commerce.login('a','A','1111')
    const {card}=await commerce.ask('a',{kind:'order',orderId:'DEMO-1001'})
    assert.match(JSON.stringify(card),/CUP-500-G/)
    assert.deepEqual(merchant.list().policies,before.policies)
  } finally {db.close()}
})

test('normalized duplicate order lines roll back and mixed sale activities use the same manual-review reasons in the trial and the handoff card', async () => {
  const {db,commerce,merchant,product,order,draft} = setup()
  try {
    const duplicate=merchant.apply({products:[product],orders:[order,{...order,行号:'01',订单号:order.订单号.toLowerCase()}]},true)
    assert.equal(duplicate.ok,false)
    assert.match(duplicate.errors.join(' '),/重复/)
    assert.equal(merchant.list().products.length,0)
    const second={...order,行号:'2',成交活动:'联名预售'}
    assert.equal(merchant.apply({products:[product],orders:[order,second],policies:[draft]},true).ok,true)
    const ids=['DEMO-1001',order.订单号]
    const trial=merchant.trial('RET-ACT-01@V4',ids)
    assert.equal(trial.results[1].after.status,'review')
    merchant.publish('RET-ACT-01@V4',ids,trial.token)
    commerce.login('a','A','1111')
    const {card,handoff}=await commerce.ask('a',{kind:'return',orderId:order.订单号})
    assert.ok(handoff)
    assert.equal(card.reason,trial.results[1].after.reason)
    assert.deepEqual(card.sources.map(s=>s.version).sort(),['CO1','CO2','V4'])
  } finally {db.close()}
})

test('publication requires draft coverage, valid cross-cutover comparisons and no unreviewed scope conflicts', () => {
  const {db,merchant,product,order,draft}=setup()
  try {
    assert.ok(merchant.apply({products:[product],orders:[order],policies:[draft]},true).ok)
    assert.throws(()=>merchant.trial('RET-ACT-01@V4',['DEMO-1001','DEMO-1005']),/适用店铺/)
    assert.throws(()=>merchant.trial('RET-ACT-01@V4',['DEMO-1001','DEMO-1002']),/实际命中/)
    const overlap={...draft,条款编号:'OTHER'}
    assert.ok(merchant.apply({policies:[overlap]},true).ok)
    const ids=['DEMO-1001',order.订单号]
    const conflict=merchant.trial('OTHER@V4',ids)
    assert.ok(conflict.issues.length)
    assert.throws(()=>merchant.publish('OTHER@V4',ids,conflict.token),/重叠/)
    assert.equal(merchant.list().policies.find(p=>p.条款编号==='OTHER')?.发布状态,'草稿')
  } finally {db.close()}
})

test('a same-start conflict identifies the published and draft versions at trial and rejected publication', () => {
  const {db,merchant}=setup()
  try {
    const ids=['DEMO-1001','DEMO-1002']
    const pair={draft:{id:'RET-ACT-01',version:'V3'},published:{id:'RET-ACT-01',version:'V2'},
      reason:'same_clause_start',at:'2026-11-15 00:00:00'}
    const trial=merchant.trial('RET-ACT-01@V3',ids)
    assert.deepEqual(trial.conflicts,[pair])
    assert.throws(()=>merchant.publish('RET-ACT-01@V3',ids,trial.token),error=>{
      assert.ok(error instanceof Error && 'conflicts' in error)
      assert.deepEqual(error.conflicts,[pair])
      return true
    })
    assert.equal(merchant.publication('RET-ACT-01@V3'),null)
  } finally {db.close()}
})

test('a competing clause lists each overlapping published version even after the latest sample order', () => {
  const {db,merchant,product,order,draft}=setup()
  try {
    const other={...draft,条款编号:'OTHER',版本:'V1','生效时间（含）':'2026-11-14 00:00:00'}
    const sample={...order,下单时间:'2026-11-14 12:00:00'}
    assert.ok(merchant.apply({products:[product],orders:[sample],policies:[other]},true).ok)
    const ids=[sample.订单号,'DEMO-1001']
    const trial=merchant.trial('OTHER@V1',ids)
    assert.deepEqual(trial.conflicts,[
      {draft:{id:'OTHER',version:'V1'},published:{id:'RET-ACT-01',version:'V1'},reason:'equal_priority_overlap',at:'2026-11-14 00:00:00'},
      {draft:{id:'OTHER',version:'V1'},published:{id:'RET-ACT-01',version:'V2'},reason:'equal_priority_overlap',at:'2026-11-15 00:00:00'},
    ])
  } finally {db.close()}
})

test('order intentions outrank a generic FAQ and short, Chinese and dotted order IDs never reuse another order', () => {
  const {db,merchant,commerce,product,order}=setup()
  try {
    const faq={问答编号:'COMMON',版本:'F1',顾客常用问法:'这笔订单能退吗？',其他常见问法:'测试杯有多大？',标准答复:'仅是通用说明',依据或来源:'规格书',状态:'已审核'}
    assert.ok(merchant.apply({products:[product],orders:['杭州-001','O1','SHOP.11'].map(订单号=>({...order,订单号})),faqs:[faq]},true).ok)
    commerce.login('s','A','1111')
    const parse=(text:string)=>commerce.parseQuery(text,'DEMO-1001','s')
    assert.deepEqual(parse('这笔订单能退吗？'),{kind:'return',orderId:'DEMO-1001'})
    assert.equal(parse('测试杯有多大？')?.kind,'faq')
    for (const id of ['杭州-001','O1','SHOP.11']) assert.deepEqual(parse('查一下'+id+'的物流'),{kind:'order',orderId:id})
    assert.notEqual((parse('订单号 【未识别】 的物流') as {orderId:string}).orderId,'DEMO-1001')
    assert.deepEqual(parse('查一下外地-003的物流'),{kind:'order',orderId:'外地-003'})
    assert.deepEqual(parse('查一下大杭州-001的物流'),{kind:'order',orderId:'大杭州-001'})
  } finally {db.close()}
})

test('two approved FAQ versions in one upload identify both conflicting rows and roll everything back', () => {
  const {db,merchant,product}=setup()
  try {
    const item={问答编号:'DUAL',版本:'F1',顾客常用问法:'容量？',其他常见问法:'',标准答复:'450 mL',依据或来源:'规格',状态:'已审核'}
    const result=merchant.apply({products:[product],faqs:[item,{...item,版本:'F2'}]},true)
    assert.equal(result.ok,false)
    assert.match(result.errors.join(' '),/第 1 行/)
    assert.match(result.errors.join(' '),/第 2 行/)
    assert.ok(!merchant.list().faqs.some(f=>f.问答编号==='DUAL'))
    assert.equal(merchant.list().products.length,0)
  } finally {db.close()}
})

test('an expired replacement does not resurrect or block a different clause after its expiry', () => {
  const {db,merchant,product,order,draft}=setup()
  try {
    const more={...order,订单号:'SHOP-102',下单时间:'2026-11-19 11:00:00',签收时间:'2026-11-20 11:00:00',物流更新时间:'2026-11-20 11:00:00'}
    const finite={...draft,'失效时间（不含）':'2026-11-18 00:00:00'}
    const replacement={...draft,条款编号:'NEXT','生效时间（含）':'2026-11-19 00:00:00'}
    assert.ok(merchant.apply({products:[product],orders:[order,more],policies:[finite,replacement]},true).ok)
    const ids=['DEMO-1001',order.订单号]
    merchant.publish('RET-ACT-01@V4',ids,merchant.trial('RET-ACT-01@V4',ids).token)
    const nextIds=[order.订单号,more.订单号]
    const trial=merchant.trial('NEXT@V4',nextIds)
    assert.deepEqual(trial.issues,[])
    assert.equal(trial.results[1].before.status,'review')
    merchant.publish('NEXT@V4',nextIds,trial.token)
  } finally {db.close()}
})
