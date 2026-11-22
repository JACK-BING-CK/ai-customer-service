import assert from 'node:assert/strict'

// Reusable simulated shop data for exercising two different decisions in one basket.
export async function prepareLineDemo(url) {
  const endpoint = new URL('/api/merchant/', url)
  const overview = await fetch(endpoint)
  assert.ok(overview.ok, '无法读取模拟店铺资料')
  const {data} = await overview.json()
  async function post(path, body) {
    const response = await fetch(new URL(path, endpoint), {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
    })
    const result = await response.json()
    assert.ok(response.ok, JSON.stringify(result))
    return result
  }
  const store = '分件售后模拟店'
  const channel = '店铺网页'
  const orderId = 'LINE-DEMO-100'
  const items = [
    {line:1,code:'CUP',name:'保温旅行杯',qty:2,activity:'旅行杯体验周',days:14,signed:'2026-11-16 12:00:00'},
    {line:2,code:'COVER',name:'防滑杯套',qty:3,activity:'配件体验周',days:5,signed:'2026-11-17 12:00:00'},
  ]
  for (const item of items) {
    const sku = 'LINE-DEMO-' + item.code
    const product = {'商品编码（SKU）':sku,商品名称:item.name,'规格或型号':'标准款',商品类别:'杯具',
      已确认的商品事实:item.name + '，标准款。',事实来源:'分件售后模拟店商品资料'}
    const existing = data.products.find(row => row['商品编码（SKU）'] === sku)
    if (existing) assert.deepEqual(existing, product, '已有商品与演示商品不同')
    else await post('save',{kind:'products',row:product})
    const control = orderId + '-' + item.code
    const row = {订单号:orderId,行号:String(item.line),店铺会员编号:'A',成交商品编码:sku,成交商品与规格:item.name,
      购买数量:String(item.qty),店铺:store,成交渠道:channel,成交活动:item.activity,下单时间:'2026-11-12 12:00:00',
      物流状态:'已签收',签收时间:item.signed,物流更新时间:item.signed}
    for (const sale of [row,{...row,订单号:control,行号:'1',下单时间:'2026-11-13 12:00:00'}]) {
      const found = data.orders.find(record => record.订单号 === sale.订单号 && record.行号 === sale.行号)
      if (found) assert.deepEqual(found, sale, '已有订单明细与演示数据不同')
      else await post('save',{kind:'orders',row:sale})
    }
    const policy = {条款编号:'RET-LINE-' + item.code,版本:'L1',名称:item.name + '退货时限',适用店铺:store,渠道:channel,
      活动:item.activity,'生效时间（含）':'2026-11-01 00:00:00','失效时间（不含）':'',按何时选版本:'下单时间',
      期限起算点:'签收次日算第 1 天',天数:String(item.days),计时口径:'日历日／北京时间／含截止日',发布状态:'草稿',
      条款原文:`签收次日起${item.days}个日历日内可申请退货。`}
    const found = data.policies.find(row => row.条款编号 === policy.条款编号 && row.版本 === policy.版本)
    if (found) assert.deepEqual({...found,发布状态:'草稿'}, policy, '已有规则与演示条款不同')
    if (found?.发布状态 === '已发布') continue
    if (!found) await post('save',{kind:'policies',row:policy})
    const input = {policyKey:policy.条款编号 + '@L1',orderIds:[orderId,control]}
    const trial = await post('trial',input)
    assert.deepEqual(trial.issues,[])
    await post('publish',{...input,token:trial.token})
  }
  return orderId
}
