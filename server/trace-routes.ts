import express from 'express'
import type {DatabaseSync} from 'node:sqlite'
import {staffAccess} from './staff-access.ts'
import {readTrace} from './trace-store.ts'

export function traceRoutes(db:DatabaseSync,key?:string) {
  const router=express.Router()
  const allowed=staffAccess(key)
  router.use((req,res,next)=>{
    res.set('Cache-Control','no-store')
    if(!allowed(req.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1])) {res.status(401).json({error:'请先登录调试后台。'});return}
    next()
  })
  router.get('/',(req,res)=>{
    const {q='',cursor,limit}=req.query
    const numberParam=(value:unknown,max:number)=>value===undefined || (typeof value==='string' && /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value)>0 && Number(value)<=max)
    if(typeof q!=='string' || q.length>160 || !numberParam(cursor,Number.MAX_SAFE_INTEGER) || !numberParam(limit,100)){
      res.status(400).json({error:'流程查询参数无效。'});return
    }
    res.json(readTrace(db,{q:q.trim(),...(cursor && {cursor:Number(cursor)}),...(limit && {limit:Number(limit)})}))
  })
  router.get('/:eventId/message',(req,res)=>{
    const id=req.params.eventId
    if(!/^EV-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) {res.status(400).json({error:'步骤编号无效。'});return}
    const message=db.prepare(`SELECT t.conversation_id AS conversationId,m.id,m.role,m.at,m.text,m.commerce_card AS card
      FROM support_trace t JOIN messages m ON m.conversation_id=t.conversation_id
        AND m.id=coalesce(json_extract(t.details,'$.messageId'),json_extract(t.details,'$.causeMessageId'))
      WHERE t.event_id=?`).get('EV-'+id.slice(3).toLowerCase())
    if(!message) {res.status(404).json({error:'该步骤没有可查阅的原消息。'});return}
    const {card,...fields}=message
    res.json({...fields,...(card && {commerceCard:JSON.parse(String(card))})})
  })
  return router
}
