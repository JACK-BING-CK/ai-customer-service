import {useEffect,useState,type FormEvent} from 'react'
import type {Message} from '../shared/protocol'
import {AppHeader,Notice} from './ui'
import {CommerceResult} from './CommerceCards'
import {agentKey,getAgentKey} from './state'
import {traceLink} from './trace-links'

const roles={customer:'顾客原话',agent:'坐席原回复',assistant:'客服原回复',system:'系统原通知'}
export function TraceMessage({eventId}:{eventId:string}) {
  const [token,setToken]=useState(()=>getAgentKey() || sessionStorage.getItem('support.debug.access') || '')
  const [input,setInput]=useState(''),[retry,setRetry]=useState(0)
  const [message,setMessage]=useState<(Message & {conversationId:string})|null>(null)
  const [denied,setDenied]=useState(false),[error,setError]=useState('')
  useEffect(()=>{
    const controller=new AbortController()
    async function load() {
      try {
        setError('');setMessage(null)
        const res=await fetch('/api/debug/trace/'+encodeURIComponent(eventId)+'/message',{cache:'no-store',signal:controller.signal,headers:token?{Authorization:'Bearer '+token}:{}})
        const data=await res.json()
        if(controller.signal.aborted)return
        setDenied(res.status===401)
        if(!res.ok) {setError(data.error || '暂时无法读取原消息。');return}
        if(token)sessionStorage.setItem(agentKey,token)
        setMessage(data)
      } catch {if(!controller.signal.aborted)setError('暂时无法读取原消息。')}
    }
    void load();return ()=>controller.abort()
  },[token,eventId,retry])
  function login(event:FormEvent) {event.preventDefault();setToken(input);setInput('');setRetry(n=>n+1)}
  return <div className="app"><AppHeader agent><a className="header-link" href={traceLink(eventId)}>返回流程日志</a></AppHeader>
    <main className="access-layout"><section className="access-card" style={{width:'min(100%, 720px)',overflowWrap:'anywhere'}}>
      <h1>{message?roles[message.role]:'查阅原消息'}</h1>
      {message && <><small>{new Date(message.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）</small>
        <p>步骤编号 {eventId}</p><p>消息编号 {message.id}</p>
        {message.commerceCard?<CommerceResult card={message.commerceCard}/>:<div style={{whiteSpace:'pre-wrap'}}>{message.text}</div>}</>}
      {denied && <form onSubmit={login}><label>坐席密钥<input type="password" required value={input} onChange={e=>setInput(e.target.value)}/></label>
        <button className="primary-button">查看原消息</button></form>}
      {error && <Notice error>{error}</Notice>}{!message && !denied && (error?<button className="secondary-button" onClick={()=>setRetry(n=>n+1)}>重试</button>:<p>正在读取原消息…</p>)}
    </section></main></div>
}
