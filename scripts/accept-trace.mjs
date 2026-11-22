import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'

export async function acceptTrace({url,login,connect,send,receive,realAI=false}) {
  async function read(q) {
    const events=[]
    let cursor
    do {
      const params=new URLSearchParams({q,limit:'8'})
      if(cursor) params.set('cursor',String(cursor))
      const res=await fetch(url+'/api/debug/trace?'+params)
      assert.equal(res.status,200)
      const page=await res.json()
      events.push(...page.events);cursor=page.nextCursor
    } while(cursor)
    return events
  }
  const session=await (await login('A','1111')).json()
  const [customer]=await connect({role:'customer',...session},'snapshot')
  const [agent]=await connect({role:'agent'},'queue')
  const endpoint=url+'/api/conversations/'+session.id+'/demo-orders'
  const headers={Authorization:'Bearer '+session.token,'Content-Type':'application/json'}
  const products=await (await fetch(endpoint,{headers})).json()
  assert.equal((await fetch(endpoint)).status,401)
  const payload={sku:products.products[0].sku,quantity:1,requestId:randomUUID()}
  const post=(input)=>fetch(endpoint,{method:'POST',headers,body:JSON.stringify(input)})
  const rejectedSteps=[]
  async function checkRejected(input,status,code) {
    const first=await post(input)
    assert.equal(first.status,status)
    const rejected=await first.json()
    assert.match(rejected.stepId,/^EV-[a-f\d-]{36}$/i)
    const repeated=await post(input)
    assert.equal(repeated.status,status)
    assert.equal((await repeated.json()).stepId,rejected.stepId)
    const entry=(await read(rejected.stepId)).find(e=>e.id===rejected.stepId)
    assert.ok(entry && entry.kind==='checkout.blocked' && entry.status==='blocked' && entry.order===null)
    assert.deepEqual(entry.details,{source:'checkout',code})
    rejectedSteps.push(entry.id)
  }
  const unknownSku='PRIVATE-MISSING-'+randomUUID()
  await checkRejected({...payload,quantity:0},400,'invalid_quantity')
  await checkRejected({...payload,sku:unknownSku},422,'product_unavailable')
  const receipt=await post(payload)
  assert.equal(receipt.status,201)
  const {orderId}=await receipt.json()
  assert.deepEqual(await (await post(payload)).json(),{orderId})
  await checkRejected({...payload,sku:unknownSku},409,'request_conflict')

  async function ask(socket,event,input,condition) {
    const next=receive(socket,'snapshot',condition)
    await send(socket,event,{...input,requestId:randomUUID()})
    return next
  }
  const isCard=s=>s.messages.at(-1)?.commerceCard?.status==='found'
  await ask(customer,'customer:commerce',{action:'order',orderId},isCard)
  if(realAI) {
    await ask(customer,'customer:send',{text:'你好。请用一句中文打个招呼。'},s=>!s.generating && s.messages.at(-1)?.role==='assistant' && !s.messages.at(-1)?.commerceCard)
    await send(customer,'customer:handoff',{})
  } else {
    await ask(customer,'customer:send',{text:'你好。请跟我打个招呼。'},s=>s.mode==='waiting')
  }
  const claimed=receive(customer,'snapshot',s=>s.mode==='human')
  await send(agent,'agent:claim',{id:session.id});await claimed
  const note='坐席已核对这笔模拟订单，它目前待发货。'
  const replied=receive(customer,'snapshot',s=>s.messages.at(-1)?.role==='agent')
  await send(agent,'agent:send',{id:session.id,text:note,requestId:randomUUID()})
  const state=await replied
  const closed=receive(customer,'snapshot',s=>s.mode==='resolved')
  await send(agent,'agent:resolve',{id:session.id,version:state.version});await closed
  const reopened=await ask(customer,'customer:send',{text:'我还想再确认一下。'},s=>s.mode==='waiting')
  assert.equal(reopened.id,session.id)
  const again=receive(customer,'snapshot',s=>s.mode==='human')
  await send(agent,'agent:claim',{id:session.id})
  const final=receive(customer,'snapshot',s=>s.mode==='resolved')
  await send(agent,'agent:resolve',{id:session.id,version:(await again).version});await final
  const flowId='TR-'+session.id
  const events=await read(flowId)
  const kinds=events.map(e=>e.kind)
  let last=-1
  for(const kind of ['session.created','order.placed','customer.message','commerce.started','identity.checked','orders.lookup','commerce.reply',
    'ai.started',realAI?'ai.completed':'ai.failed','handoff.waiting','agent.claimed','agent.reply','session.resolved','session.reopened','agent.claimed','session.resolved']) {
    const pos=kinds.indexOf(kind,last+1)
    assert.ok(pos>last,kind+': '+kinds.join(', '));last=pos
  }
  assert.equal(events.filter(e=>e.kind==='order.placed').length,1)
  assert.equal(events.filter(e=>e.kind==='checkout.blocked').length,3)
  assert.equal(new Set(rejectedSteps).size,3)
  assert.ok(!JSON.stringify(events).includes(unknownSku))
  assert.equal(new Set(events.map(e=>e.id)).size,events.length)
  assert.ok(events.every(e=>/^EV-[a-f\d-]{36}$/i.test(e.id)))
  const step=events.find(e=>e.kind==='agent.reply')
  const original=await (await fetch(url+'/api/debug/trace/'+step.id+'/message')).json()
  assert.equal(original.text,note)
  assert.equal(original.conversationId,session.id)
  const orderTrail=await read(orderId)
  assert.ok(orderTrail.some(e=>e.id===step.id))
  assert.ok((await read(step.id)).some(e=>e.id===step.id))
  assert.ok(!JSON.stringify(events).includes(session.token) && !JSON.stringify(events).includes(note))
  const other=await (await login('B','2222')).json()
  const [b]=await connect({role:'customer',...other},'snapshot')
  await ask(b,'customer:commerce',{action:'order',orderId},s=>s.messages.at(-1)?.commerceCard?.status==='not_found')
  const denied=await read('TR-'+other.id)
  assert.ok(denied.some(e=>e.status==='blocked'))
  assert.ok(!JSON.stringify(denied).includes(orderId))
  assert.ok(!(await read(orderId)).some(e=>e.conversationId===other.id))
  const self=await (await login('A','1111')).json()
  const [selfSocket]=await connect({role:'customer',...self},'snapshot')
  const reply=await ask(selfSocket,'customer:commerce',{action:'faq',text:'退货怎么申请？'},s=>s.mode==='ai' && !!s.messages.at(-1)?.commerceCard)
  const resolved=receive(selfSocket,'snapshot',s=>s.mode==='resolved')
  await send(selfSocket,'customer:resolve',{version:reply.version});await resolved
  await send(selfSocket,'customer:resolve',{version:reply.version})
  const auto=await read('TR-'+self.id)
  assert.equal(auto.filter(e=>e.kind==='customer.resolved').length,1)
  assert.ok(!auto.some(e=>e.kind==='agent.claimed'))
  const outcome={orderId,flowId,stepId:step.id,blockedCheckoutSteps:rejectedSteps,steps:events.length,debug:url+'/debug?trace='+flowId}
  console.log('通过：顾客模拟下单、客服回答、查本人订单、坐席接单回复、办结重开再办结均可追溯。数量无效、商品不存在、重复下单号改商品均可按步骤编号定位，重试沿用原编号，跨账号查单单独留痕。')
  console.log(JSON.stringify(outcome))
  return outcome
}
