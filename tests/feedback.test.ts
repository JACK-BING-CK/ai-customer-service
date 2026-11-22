import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStore} from '../server/store.ts'
import {openCommerce} from '../server/commerce.ts'
import {openMerchant} from '../server/merchant-store.ts'
import {openFeedback} from '../server/feedback-store.ts'
import {createService} from '../server/service.ts'
import {readTrace} from '../server/trace-store.ts'

function setup() {
  const store=openStore(':memory:')
  const commerce=openCommerce(store.database)
  const merchant=openMerchant(store.database)
  const feedback=openFeedback(store.database,merchant)
  const id=store.create().id
  return {store,commerce,merchant,feedback,id}
}

test('unanswered handoff becomes an immutable case, only a matching replay releases its FAQ',async()=>{
  const {store,commerce,merchant,feedback,id}=setup()
  try {
    const question='旅行杯有保修吗？', answer='模拟店铺提供一年保修。'
    store.append(id,'customer',question,{commerceQuery:{kind:'faq',question}})
    const {card}=await commerce.ask(id,{kind:'faq',question})
    store.append(id,'assistant',card.summary,{commerceCard:card,nextMode:'waiting',handoffReason:card.reason})
    const input={messageId:store.snapshot(id)!.messages[0].id,reason:'faq_gap' as const,expected:{kind:'faq' as const,answer}}
    assert.throws(()=>feedback.capture(id,input),/接待/)
    store.setMode(id,'waiting','human')
    let c=feedback.capture(id,input)
    assert.equal(feedback.capture(id,input).id,c.id)
    assert.equal(c.originalAnswer,card.summary)
    const row={问答编号:'WARRANTY',版本:'R1',顾客常用问法:question,其他常见问法:'',标准答复:'半年保修。',依据或来源:'模拟商品说明',状态:'草稿'}
    c=feedback.saveDraft(c.id,{kind:'faq',row},c.version)
    assert.throws(()=>feedback.publish(c.id,c.version),/回放/)
    assert.equal(merchant.apply({faqs:[{...row,状态:'已审核'}]},true).ok,false)
    c=feedback.replay(c.id,c.version)
    assert.equal(c.replay?.passed,false)
    assert.throws(()=>feedback.publish(c.id,c.version),/回放/)
    c=feedback.saveDraft(c.id,{kind:'faq',row:{...row,标准答复:answer}},c.version)
    assert.throws(()=>feedback.replay(c.id,c.version-1),/刷新/)
    c=feedback.replay(c.id,c.version)
    assert.equal(c.replay?.passed,true)
    assert.equal((await commerce.ask(id,{kind:'faq',question})).handoff,true)
    const published=feedback.publish(c.id,c.version)
    assert.equal(feedback.publish(c.id,c.version).publishedAt,published.publishedAt)
    assert.equal((await commerce.ask(id,{kind:'faq',question})).card.summary,answer)
    assert.equal(feedback.list(id)[0].originalAnswer,card.summary)
    const trail=readTrace(store.database,{q:id}).events.filter(e=>e.kind.startsWith('feedback.'))
    assert.deepEqual(trail.map(e=>e.kind),['feedback.captured','feedback.draft','feedback.publish_blocked','feedback.replayed',
      'feedback.publish_blocked','feedback.draft','feedback.replayed','feedback.published'])
    assert.ok(trail.every(e=>e.details.caseId===c.id))
    assert.deepEqual(trail.filter(e=>e.kind==='feedback.replayed').map(e=>e.status),['blocked','ok'])
  } finally {store.close()}
})

test('policy replay freezes verified order facts and checks old and new orders before publication',async()=>{
  const {store,commerce,merchant,feedback,id}=setup()
  try {
    commerce.login(id,'A','1111')
    const query={kind:'return' as const,orderId:'DEMO-1002'}
    store.append(id,'customer','这单能退吗？',{commerceQuery:query})
    const {card}=await commerce.ask(id,query)
    store.append(id,'assistant',card.summary,{commerceCard:card,onApplied:()=>commerce.saveCard(id,card),nextMode:'human'})
    let c=feedback.capture(id,{messageId:store.snapshot(id)!.messages[0].id,reason:'policy_issue',expected:{kind:'policy',status:'expired',
      versions:['RET-ACT-01@FIX'],deadline:'2026-11-21 23:59:59'}})
    const row={...merchant.list().policies.find(p=>p.版本==='V2')!,版本:'FIX','生效时间（含）':'2026-11-14 23:59:59',天数:'5',条款原文:'签收次日起5个日历日内可申请退货。'}
    c=feedback.saveDraft(c.id,{kind:'policy',row,orderIds:['DEMO-1001','DEMO-1002']},c.version)
    c=feedback.replay(c.id,c.version)
    assert.equal(c.replay?.passed,false)
    assert.ok(c.replay!.issues.length)
    assert.throws(()=>feedback.publish(c.id,c.version),/回放/)
  } finally {store.close()}
})

test('a policy correction reaches the same order in the customer window and keeps the original answer',async()=>{
  const {store,commerce,merchant,feedback,id}=setup()
  try {
    const original=merchant.list().orders.find(o=>o.订单号==='DEMO-1002')!
    const order={...original,订单号:'FIX-1006',成交商品编码:'FIX-CUP',下单时间:'2026-11-15 12:00:00'}
    const product={'商品编码（SKU）':'FIX-CUP',商品名称:'模拟杯',规格或型号:'一件',商品类别:'杯具',已确认的商品事实:'样品',事实来源:'模拟说明'}
    assert.ok(merchant.apply({orders:[order],products:[product]},true).ok)
    commerce.login(id,'A','1111')
    const query={kind:'return' as const,orderId:order.订单号}
    store.append(id,'customer','这个订单还能退吗？',{commerceQuery:query})
    const {card}=await commerce.ask(id,query)
    assert.equal(card.status,'eligible')
    store.append(id,'assistant',card.summary,{commerceCard:card,onApplied:()=>commerce.saveCard(id,card),nextMode:'human'})
    let entry=feedback.capture(id,{messageId:store.snapshot(id)!.messages[0].id,reason:'policy_issue',expected:{kind:'policy',status:'expired',
      versions:['RET-ACT-01@FIX3'],deadline:'2026-11-19 23:59:59'}})
    const row={...merchant.list().policies.find(p=>p.版本==='V2')!,版本:'FIX3','生效时间（含）':order.下单时间,天数:'3',条款原文:'签收次日起3个日历日内可申请退货。'}
    const orderIds=['DEMO-1001',order.订单号]
    entry=feedback.saveDraft(entry.id,{kind:'policy',row,orderIds},entry.version)
    entry=feedback.replay(entry.id,entry.version)
    assert.equal(entry.replay?.passed,true,JSON.stringify(entry.replay))
    assert.ok(merchant.list().policies.every(p=>p.版本!=='FIX3'))
    entry=feedback.publish(entry.id,entry.version)
    assert.equal(entry.status,'published')
    assert.ok(merchant.publication('RET-ACT-01@FIX3'))
    assert.equal((await commerce.ask(id,query)).card.status,'expired')
    assert.equal((await commerce.ask(id,{kind:'return',orderId:orderIds[0]})).card.sources[0].version,'V1')
    assert.equal(store.snapshot(id)!.messages[1].commerceCard?.status,'eligible')
  } finally {store.close()}
})

test('a later related case invalidates approval and a lost alias blocks publication',()=>{
  const {store,merchant,feedback,id}=setup()
  try {
    const a='电池保修多久？',b='电池有保修吗？',answer='五年。'
    const base={问答编号:'CELL',版本:'1',顾客常用问法:a,其他常见问法:b,标准答复:'三年。',依据或来源:'门店手册',状态:'已审核'}
    merchant.apply({faqs:[base]},true)
    store.append(id,'customer',a,{nextMode:'human',faqRoute:'chat'})
    let entry=feedback.capture(id,{messageId:store.snapshot(id)!.messages[0].id,reason:'faq_wrong',expected:{kind:'faq',answer}})
    entry=feedback.saveDraft(entry.id,{kind:'faq',row:{...base,版本:'2',其他常见问法:'',标准答复:answer}},entry.version)
    entry=feedback.replay(entry.id,entry.version)
    assert.equal(entry.replay?.passed,true)
    const next=store.create().id
    store.append(next,'customer',b,{nextMode:'human',faqRoute:'chat'})
    feedback.capture(next,{messageId:store.snapshot(next)!.messages[0].id,reason:'faq_wrong',expected:{kind:'faq',answer}})
    assert.throws(()=>feedback.publish(entry.id,entry.version),/重新回放/)
    entry=feedback.get(entry.id)!
    assert.equal(entry.status,'draft')
    assert.equal(entry.replay,null)
    entry=feedback.replay(entry.id,entry.version)
    assert.equal(entry.status,'blocked')
    assert.equal(entry.replay!.rows.length,2)
    entry=feedback.saveDraft(entry.id,{kind:'faq',row:{...base,版本:'2',标准答复:answer}},entry.version)
    assert.equal(feedback.replay(entry.id,entry.version).status,'passed')
  } finally {store.close()}
})

test('policy publication compares deadlines and cited versions independently of the eligibility status',async()=>{
  const {store,commerce,merchant,feedback,id}=setup()
  try {
    const baseline=merchant.list().orders.find(o=>o.订单号==='DEMO-1002')!
    const order={...baseline,订单号:'CASE-EXACT',成交商品编码:'CUP-EXACT',下单时间:'2026-11-15 12:00:00'}
    const product={'商品编码（SKU）':'CUP-EXACT',商品名称:'模拟杯',规格或型号:'一件',商品类别:'杯具',已确认的商品事实:'样品',事实来源:'说明'}
    assert.ok(merchant.apply({products:[product],orders:[order]},true).ok)
    commerce.login(id,'A','1111')
    const query={kind:'return' as const,orderId:order.订单号}
    store.append(id,'customer','还剩几天？',{commerceQuery:query,faqRoute:'explicit_order'})
    const {card}=await commerce.ask(id,query)
    store.append(id,'assistant',card.summary,{commerceCard:card,onApplied:()=>commerce.saveCard(id,card),nextMode:'human'})
    const messageId=store.snapshot(id)!.messages[0].id
    const expected={kind:'policy' as const,status:'eligible' as const,deadline:'2026-11-30 23:59:59',versions:['RET-ACT-01@NEXT']}
    store.append(id,'customer','我还没有选择商品',{commerceQuery:query})
    const promptId=store.snapshot(id)!.messages.at(-1)!.id
    store.append(id,'assistant','请选择商品',{commerceCard:{...card,status:'select_line'}})
    assert.throws(()=>feedback.capture(id,{messageId:promptId,reason:'policy_issue',expected}),/判断卡/)
    assert.throws(()=>feedback.capture(id,{messageId,reason:'policy_issue',expected:{...expected,versions:undefined}}),/同时标注/)
    assert.throws(()=>feedback.capture(id,{messageId,reason:'policy_issue',expected:{...expected,deadline:undefined}}),/同时标注/)
    assert.throws(()=>feedback.capture(id,{messageId,reason:'policy_issue',expected:{...expected,deadline:'2026-11-31 23:59:59'}}),/截止/)
    assert.throws(()=>feedback.capture(id,{messageId,reason:'policy_issue',expected:{...expected,versions:['NEXT']}}),/版本/)
    let entry=feedback.capture(id,{messageId,reason:'policy_issue',expected})
    const orders=['DEMO-1001',order.订单号]
    const revise=(version:string,days:number)=>{
      const row={...merchant.list().policies.find(p=>p.版本==='V2')!,版本:version,'生效时间（含）':order.下单时间,
        天数:String(days),条款原文:'签收次日起'+days+'个日历日内可申请退货。'}
      entry=feedback.saveDraft(entry.id,{kind:'policy',row,orderIds:orders},entry.version)
      entry=feedback.replay(entry.id,entry.version)
      return entry.replay!.rows.find(row=>row.caseId===entry.id)!
    }
    const short=revise('NEXT',13)
    assert.equal(short.passed,false)
    assert.match(short.detail,/截止.*预期.*11-30.*实际.*11-29/)
    assert.throws(()=>feedback.publish(entry.id,entry.version),/未通过/)
    const wrongVersion=revise('WRONG',14)
    assert.equal(wrongVersion.passed,false)
    assert.match(wrongVersion.detail,/版本.*RET-ACT-01@NEXT.*RET-ACT-01@WRONG/)
    assert.equal(revise('NEXT',14).passed,true)
    assert.equal(feedback.publish(entry.id,entry.version).status,'published')
    assert.equal((await commerce.ask(id,query)).card.deadline,expected.deadline)
  } finally {store.close()}
})

test('a saved legacy policy case can be reopened, retried, and replayed with its original status-only expectation',async()=>{
  const {store,commerce,merchant,feedback,id}=setup()
  try {
    const product={'商品编码（SKU）':'LEGACY-CUP',商品名称:'模拟杯',规格或型号:'一个',商品类别:'杯具',已确认的商品事实:'样品',事实来源:'说明'}
    const order={...merchant.list().orders.find(o=>o.订单号==='DEMO-1002')!,订单号:'CASE-LEGACY',成交商品编码:'LEGACY-CUP',下单时间:'2026-11-15 12:00:00'}
    assert.ok(merchant.apply({products:[product],orders:[order]},true).ok)
    commerce.login(id,'A','1111')
    const query={kind:'return' as const,orderId:order.订单号}
    store.append(id,'customer','这个订单还能退吗？',{commerceQuery:query,faqRoute:'explicit_order'})
    const {card}=await commerce.ask(id,query)
    store.append(id,'assistant',card.summary,{commerceCard:card,onApplied:()=>commerce.saveCard(id,card),nextMode:'human'})
    const input={messageId:store.snapshot(id)!.messages[0].id,reason:'policy_issue' as const,expected:{kind:'policy' as const,status:'eligible' as const}}
    const saved=feedback.capture(id,{...input,expected:{...input.expected,deadline:card.deadline,versions:['RET-ACT-01@V2']}})
    store.database.prepare('UPDATE feedback_cases SET record=? WHERE id=?').run(JSON.stringify({...saved,expected:input.expected}),saved.id)
    assert.deepEqual(feedback.get(saved.id)?.expected,input.expected)
    assert.equal(feedback.capture(id,input).id,saved.id)
    const row={...merchant.list().policies.find(p=>p.版本==='V2')!,版本:'LEGACY','生效时间（含）':order.下单时间,天数:'13',条款原文:'签收次日起13个日历日内可申请退货。'}
    const draft=feedback.saveDraft(saved.id,{kind:'policy',row,orderIds:['DEMO-1001',order.订单号]},saved.version)
    const replay=feedback.replay(saved.id,draft.version).replay!
    assert.equal(replay.passed,true)
    assert.deepEqual(replay.rows[0].checks?.map(check=>check.field),['status'])
    assert.equal(replay.rows[0].checks![0].passed,true)
  } finally {store.close()}
})

test('a direct handoff without a question records a reason but cannot supply review evidence',()=>{
  const {store,feedback,id}=setup()
  try {
    store.setMode(id,'ai','waiting')
    store.setMode(id,'waiting','human')
    const entry=feedback.capture(id,{messageId:'',reason:'customer_request',expected:{kind:'none'}})
    assert.equal(entry.reason,'customer_request')
    assert.throws(()=>feedback.saveDraft(entry.id,{kind:'faq',row:{}},entry.version),/预期/)
    assert.throws(()=>feedback.replay(entry.id,entry.version),/草稿/)
  } finally {store.close()}
})

test('a later delivery update cannot rewrite historical order evidence, and a foreign order cannot become a policy case',async()=>{
  const {store,commerce,merchant,feedback,id}=setup()
  try {
    const original=merchant.list().orders.find(o=>o.订单号==='DEMO-1003')!
    const order={...original,订单号:'FIX-PENDING',成交商品编码:'CUP-PEND',下单时间:'2026-11-15 12:00:00'}
    const product={'商品编码（SKU）':'CUP-PEND',商品名称:'模拟杯',规格或型号:'一个',商品类别:'杯具',已确认的商品事实:'样品',事实来源:'模拟说明'}
    assert.ok(merchant.apply({orders:[order],products:[product]},true).ok)
    commerce.login(id,'A','1111')
    const query={kind:'return' as const,orderId:order.订单号}
    store.append(id,'customer','这单可以退货吗？',{commerceQuery:query})
    const {card}=await commerce.ask(id,query)
    assert.equal(card.status,'review')
    store.append(id,'assistant',card.summary,{commerceCard:card,onApplied:()=>commerce.saveCard(id,card),nextMode:'human'})
    const delivered={...order,物流状态:'已签收',签收时间:'2026-11-22 14:00:00',物流更新时间:'2026-11-22 14:00:00'}
    assert.ok(merchant.apply({orders:[delivered]},true).ok)
    assert.equal((await commerce.ask(id,query)).card.status,'eligible')
    let c=feedback.capture(id,{messageId:store.snapshot(id)!.messages[0].id,reason:'missing_facts',expected:{kind:'policy',status:'review',deadline:null,versions:['RET-ACT-01@FIX4']}})
    const row={...merchant.list().policies.find(p=>p.版本==='V2')!,版本:'FIX4','生效时间（含）':order.下单时间,天数:'5',条款原文:'签收次日起5个日历日内可申请退货。'}
    c=feedback.saveDraft(c.id,{kind:'policy',row,orderIds:['DEMO-1001',order.订单号]},c.version)
    c=feedback.replay(c.id,c.version)
    assert.equal(c.replay?.passed,true)
    assert.match(c.replay!.rows[0].after,/缺少截至判断时间的签收记录/)
    assert.deepEqual(c.replay!.rows[0].checks?.find(check=>check.field==='deadline'),{field:'deadline',expected:'无截止时间',actual:'无截止时间',passed:true})
    const foreign={kind:'return' as const,orderId:'DEMO-2001'}
    store.append(id,'customer','查别人的单',{commerceQuery:foreign})
    const denied=await commerce.ask(id,foreign)
    store.append(id,'assistant',denied.card.summary,{commerceCard:denied.card})
    assert.throws(()=>feedback.capture(id,{messageId:store.snapshot(id)!.messages[2].id,reason:'policy_issue',expected:{kind:'policy',status:'review',versions:[],deadline:null}}),/本人订单/)
  } finally {store.close()}
})

test('replay respects chat handoff and basis priorities and distinguishes the explicit FAQ button', async()=>{
  const {store,commerce,feedback,id}=setup()
  const service=createService(store,async function*(){yield '测试答复'},()=>{},commerce)
  try {
    async function check(conversation:string,text:string,version:string,passed:boolean,detail:RegExp) {
      const first=store.snapshot(conversation)!.messages.findLast(m=>m.role==='customer' && m.text===text)!
      let c=feedback.capture(conversation,{messageId:first.id,reason:'faq_gap',expected:{kind:'faq',answer:'标准答复。'}})
      const row={问答编号:'FAQ-'+version,版本:'1',顾客常用问法:text,其他常见问法:'',标准答复:'标准答复。',依据或来源:'测试',状态:'草稿'}
      c=feedback.saveDraft(c.id,{kind:'faq',row},c.version)
      c=feedback.replay(c.id,c.version)
      assert.equal(c.replay!.rows.find(r=>r.caseId===c.id)!.passed,passed)
      assert.match(c.replay!.rows.find(r=>r.caseId===c.id)!.after,detail)
    }
    service.sendCustomer(id,{requestId:'handoff',text:'转人工'})
    assert.equal(store.snapshot(id)?.mode,'waiting')
    service.claim(id)
    await check(id,'转人工','HANDOFF',false,/转人工/)
    const button=store.create().id
    service.sendCommerce(button,{action:'faq',requestId:'button',text:'转人工'})
    while (service.isCheckingOrder(button)) await new Promise(resolve=>setTimeout(resolve,1))
    service.claim(button)
    await check(button,'转人工','BUTTON',true,/标准答复/)
    const previous=store.create().id
    commerce.login(previous,'A','1111')
    const {card}=await commerce.ask(previous,{kind:'return',orderId:'DEMO-1002'})
    store.append(previous,'assistant',card.summary,{commerceCard:card,onApplied:()=>commerce.saveCard(previous,card)})
    store.append(previous,'customer','为什么？',{nextMode:'human'})
    await check(previous,'为什么？','BASIS',false,/判断依据/)
  } finally {service.shutdown();store.close()}
})

test('a newly approved FAQ cannot make a natural-language policy replay report an unreachable return decision',async()=>{
  const {store,commerce,feedback,merchant,id}=setup()
  const service=createService(store,async function*(){yield '测试答复'},()=>{},commerce)
  try {
    commerce.login(id,'A','1111')
    const returned=await commerce.ask(id,{kind:'return',orderId:'DEMO-1002'})
    store.append(id,'assistant',returned.card.summary,{commerceCard:returned.card,onApplied:()=>commerce.saveCard(id,returned.card)})
    service.sendCustomer(id,{text:'想退',requestId:'policy'})
    while (service.isCheckingOrder(id)) await new Promise(resolve=>setTimeout(resolve,1))
    assert.equal(store.snapshot(id)!.messages.at(-1)?.commerceCard?.kind,'return')
    service.requestHandoff(id)
    service.claim(id)
    let c=feedback.capture(id,{messageId:store.snapshot(id)!.messages[1].id,reason:'policy_issue',expected:{kind:'policy',status:'eligible',
      versions:['RET-ACT-01@SHADOW'],deadline:'2026-11-30 23:59:59'}})
    const row={...merchant.list().policies.find(p=>p.版本==='V2')!,版本:'SHADOW'}
    c=feedback.saveDraft(c.id,{kind:'policy',row,orderIds:['DEMO-1001','DEMO-1002']},c.version)
    const faq={问答编号:'SHADOW',版本:'1',顾客常用问法:'想退',其他常见问法:'',标准答复:'请选择订单。',依据或来源:'测试',状态:'已审核'}
    assert.ok(merchant.apply({faqs:[faq]},true).ok)
    assert.equal(commerce.parseQuery('想退','DEMO-1002',id)?.kind,'faq')
    c=feedback.replay(c.id,c.version)
    assert.match(c.replay!.rows[0].after,/问答会优先/)
    assert.equal(c.replay!.rows[0].passed,false)
  } finally {service.shutdown();store.close()}
})

test('publishing an FAQ checks historical policy conversations its new aliases could take away',async()=>{
  const {store,commerce,feedback,id}=setup()
  const service=createService(store,async function*(){yield '测试答复'},()=>{},commerce)
  try {
    async function policyCase(text:string,button=false) {
      const cid=store.create().id
      commerce.login(cid,'A','1111')
      const latest=await commerce.ask(cid,{kind:'return',orderId:'DEMO-1002'})
      store.append(cid,'assistant',latest.card.summary,{commerceCard:latest.card,onApplied:()=>commerce.saveCard(cid,latest.card)})
      if (button) service.sendCommerce(cid,{action:'return',requestId:'case',orderId:'DEMO-1002'})
      else service.sendCustomer(cid,{requestId:'case',text})
      while (service.isCheckingOrder(cid)) await new Promise(resolve=>setTimeout(resolve,1))
      assert.equal(store.snapshot(cid)!.messages.at(-1)!.commerceCard?.status,'eligible')
      service.requestHandoff(cid)
      service.claim(cid)
      return feedback.capture(cid,{messageId:store.snapshot(cid)!.messages[1].id,reason:'policy_issue',expected:{kind:'policy',status:'eligible',
        versions:['RET-ACT-01@V2'],deadline:'2026-11-30 23:59:59'}})
    }
    const natural=await policyCase('想退')
    const protectedChat=await policyCase('这笔订单能退吗？')
    const protectedButton=await policyCase('',true)
    const question='保修单需要盖章吗？'
    service.sendCommerce(id,{action:'faq',requestId:'target',text:question})
    while (service.isCheckingOrder(id)) await new Promise(resolve=>setTimeout(resolve,1))
    service.claim(id)
    let c=feedback.capture(id,{messageId:store.snapshot(id)!.messages[0].id,reason:'faq_gap',expected:{kind:'faq',answer:'需要盖章。'}})
    const retained=protectedChat.question+'／'+protectedButton.question
    const row={问答编号:'STAMP',版本:'1',顾客常用问法:question,其他常见问法:retained+'／想退',标准答复:'需要盖章。',依据或来源:'测试',状态:'草稿'}
    c=feedback.saveDraft(c.id,{kind:'faq',row},c.version)
    c=feedback.replay(c.id,c.version)
    assert.equal(c.replay!.rows.find(r=>r.caseId===c.id)!.passed,true)
    const lost=c.replay!.rows.find(r=>r.caseId===natural.id)
    assert.ok(lost,'应纳入可能被别名截走的历史退货咨询')
    assert.match(lost.before,/可申请退货/)
    assert.match(lost.after,/问答会优先/)
    assert.equal(lost.passed,false)
    assert.throws(()=>feedback.publish(c.id,c.version),/未通过/)
    c=feedback.saveDraft(c.id,{kind:'faq',row:{...row,其他常见问法:retained}},c.version)
    c=feedback.replay(c.id,c.version)
    assert.equal(c.replay!.passed,true)
    assert.equal(feedback.publish(c.id,c.version).status,'published')
    assert.equal(commerce.parseQuery('这笔订单能退吗？','DEMO-1002',protectedChat.conversationId)?.kind,'return')
  } finally {service.shutdown();store.close()}
})
