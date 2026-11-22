import {useRef,useState} from 'react'
import {makeRequestId,type CustomerSession} from './state'
import {CopyTraceId} from './CopyTraceId'

export function DemoCheckout({session,disabled,onOrder}:{session:CustomerSession; disabled:boolean; onOrder:(id:string)=>void}) {
  const [open,setOpen]=useState(false)
  const [products,setProducts]=useState<{sku:string;name:string}[]>([])
  const [sku,setSku]=useState(''),[quantity,setQuantity]=useState('1')
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[receipt,setReceipt]=useState('')
  const [failedStep,setFailedStep]=useState('')
  const lock=useRef(false)
  const pending=useRef<{key:string;requestId:string}|null>(null)
  const url='/api/conversations/'+encodeURIComponent(session.id)+'/demo-orders'
  async function toggle() {
    if(open) {setOpen(false);return}
    setOpen(true);setError('');setFailedStep('');setBusy(true)
    try {
      const res=await fetch(url,{headers:{Authorization:'Bearer '+session.token},signal:AbortSignal.timeout(10000)})
      const data=await res.json()
      if(!res.ok) throw Error(data.error ?? '商品读取失败')
      setProducts(data.products);setSku(current=>data.products.some((p:{sku:string})=>p.sku===current)?current:data.products[0]?.sku ?? '')
    } catch {setError('暂时无法读取商品，请收起后重试。')} finally {setBusy(false)}
  }
  async function place() {
    if(lock.current || disabled || !sku) return
    lock.current=true;setBusy(true);setError('');setFailedStep('')
    const key=JSON.stringify([sku,quantity])
    if(pending.current?.key!==key) pending.current={key,requestId:makeRequestId()}
    try {
      const res=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json'},
        body:JSON.stringify({sku,quantity:Number(quantity),requestId:pending.current.requestId}),signal:AbortSignal.timeout(12000)})
      const data=await res.json()
      if(!res.ok) {
        if(typeof data.stepId==='string') setFailedStep(data.stepId)
        throw Error(data.error ?? '下单未完成')
      }
      pending.current=null;setReceipt(data.orderId);setOpen(false);onOrder(data.orderId)
    } catch(e) {setError(e instanceof Error && !['TypeError','TimeoutError'].includes(e.name)?e.message:'暂未收到确认，请用相同商品和数量重试。')}
    finally {lock.current=false;setBusy(false)}
  }
  const count=Number(quantity)
  return <div className="commerce-query-body">
    <button type="button" className="link-button" aria-expanded={open} disabled={busy || disabled} onClick={()=>void toggle()}>{open?'收起模拟下单':'模拟下单'}</button>
    {open && <><label>模拟商品<select value={sku} disabled={busy} onChange={e=>setSku(e.target.value)}>{products.map(p=><option key={p.sku} value={p.sku}>{p.name}</option>)}</select></label>
      <label>购买数量<input type="number" min="1" max="99" step="1" value={quantity} disabled={busy} onChange={e=>setQuantity(e.target.value)}/></label>
      <button type="button" className="secondary-button" disabled={busy || disabled || !sku || !Number.isInteger(count) || count<1 || count>99} onClick={()=>void place()}>确认模拟下单</button></>}
    {error && <p role="alert">{error}</p>}
    {failedStep && <p className="commerce-help" style={{overflowWrap:'anywhere'}}>本次下单步骤编号 <code>{failedStep}</code> <CopyTraceId key={failedStep} value={failedStep} label="复制下单步骤编号" compact /></p>}
    {receipt && <p className="commerce-help" role="status" style={{overflowWrap:'anywhere'}}>模拟订单已创建：{receipt}</p>}
  </div>
}
