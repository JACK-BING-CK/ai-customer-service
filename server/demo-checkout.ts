import express from 'express'
import {randomUUID} from 'node:crypto'
import type {DatabaseSync} from 'node:sqlite'
import type {openStore} from './store.ts'
import type {openMerchant} from './merchant-store.ts'
import {DEMO_NOW} from './commerce-fixtures.ts'
import {storeTime} from './commerce-rules.ts'
import type {MerchantRow} from '../shared/merchant.ts'
import {appendTrace} from './trace-store.ts'

const sample:MerchantRow={'商品编码（SKU）':'DEMO-TRAVEL-CUP',商品名称:'山溪旅行杯',规格或型号:'标准款',商品类别:'杯具',已确认的商品事实:'演示用旅行杯',事实来源:'模拟店铺商品资料'}

export function demoCheckoutRoutes(store:ReturnType<typeof openStore>,merchant:ReturnType<typeof openMerchant>,publish:(id:string)=>void) {
  const db:DatabaseSync=store.database
  db.exec(`CREATE TABLE IF NOT EXISTS demo_checkout_requests (
    conversation TEXT NOT NULL REFERENCES conversations(id), request_id TEXT NOT NULL, sku TEXT NOT NULL,
    quantity INTEGER NOT NULL, order_id TEXT NOT NULL, PRIMARY KEY(conversation,request_id)
  ) STRICT`)
  const account=db.prepare('SELECT account FROM commerce_accounts WHERE conversation=?')
  const product=db.prepare('SELECT payload FROM commerce_products WHERE sku=?')
  const products=db.prepare('SELECT payload FROM commerce_products ORDER BY sku')
  const receipt=db.prepare('SELECT sku,quantity,order_id FROM demo_checkout_requests WHERE conversation=? AND request_id=?')
  const router=express.Router({mergeParams:true})
  router.use((req,res,next)=>{
    const id=String(req.params.conversationId ?? '')
    res.set('Cache-Control','no-store')
    if (!store.authenticate(id,req.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1] ?? '') || !account.get(id)) {
      res.status(401).json({error:'请先登录测试账号再模拟下单。'});return
    }
    res.locals.conversationId=id
    next()
  })
  router.get('/',(_req,res)=>{
    const rows=products.all().map(r=>JSON.parse(String(r.payload)) as MerchantRow)
    res.json({products:(rows.length?rows:[sample]).map(r=>({sku:r['商品编码（SKU）'],name:r.商品名称+' · '+r.规格或型号}))})
  })
  router.post('/',express.json({limit:'2kb'}),(req,res)=>{
    const {sku,quantity,requestId}=req.body ?? {}
    const id:string=res.locals.conversationId
    // The trace store hashes the deduplication key. No unverified references or raw form values are included in the event.
    function rejection(status:number,code:string,error:string) {
      const stepId=appendTrace(db,{kind:status===500?'checkout.failed':'checkout.blocked',status:status===500?'error':'blocked',
        conversationId:id,details:{source:'checkout',code},dedupeKey:JSON.stringify([requestId,sku,quantity,code])})
      res.status(status).json({error,stepId})
    }
    if (typeof requestId!=='string' || !/^[a-f0-9-]{32,36}$/i.test(requestId)) {
      rejection(400,'invalid_request_id','下单请求编号无效，请重新提交。');return
    }
    if (typeof sku!=='string' || !sku || sku.length>64) {
      rejection(400,'invalid_product','请选择有效商品。');return
    }
    if (!Number.isInteger(quantity) || quantity<1 || quantity>99) {
      rejection(400,'invalid_quantity','数量须为 1 至 99 件。');return
    }
    let orderId:string
    db.exec('BEGIN IMMEDIATE')
    try {
      const prev=receipt.get(id,requestId)
      if (prev) {
        db.exec('ROLLBACK')
        if(prev.sku!==sku || prev.quantity!==quantity) rejection(409,'request_conflict','该下单请求已用于其他商品或数量。')
        else res.json({orderId:prev.order_id})
        return
      }
      const found=product.get(sku)
      const addSample=!found && sku===sample['商品编码（SKU）'] && !db.prepare('SELECT 1 FROM commerce_products LIMIT 1').get()
      if (!found && !addSample) {db.exec('ROLLBACK');rejection(422,'product_unavailable','商品资料已变化，请重新选择。');return}
      const item:MerchantRow=found?JSON.parse(String(found.payload)):sample
      orderId='SIM-'+randomUUID().toUpperCase()
      const when=storeTime(DEMO_NOW)
      const result=merchant.apply({...(addSample && {products:[sample]}),orders:[{订单号:orderId,行号:'1',
        店铺会员编号:String(account.get(id)!.account),成交商品编码:sku,成交商品与规格:item.商品名称+' · '+item.规格或型号,
        购买数量:String(quantity),店铺:'山溪测试店',成交渠道:'店铺网页',成交活动:'秋季活动',下单时间:when,物流状态:'待发货',签收时间:'',物流更新时间:when}]},
        true,undefined,{source:'checkout',conversationId:id})
      if (!result.ok) throw Error('无法保存模拟订单')
      db.prepare('INSERT INTO demo_checkout_requests VALUES(?,?,?,?,?)').run(id,requestId,sku,quantity,orderId)
      db.exec('COMMIT')
    } catch {
      if(db.isTransaction) db.exec('ROLLBACK')
      rejection(500,'checkout_error','模拟订单暂时未能保存，请重试。');return
    }
    res.status(201).json({orderId})
    publish(id)
  })
  return router
}
