import {createHash,randomUUID} from 'node:crypto'
import type {DatabaseSync,SQLInputValue,SQLOutputValue} from 'node:sqlite'
import type {CommerceCard} from '../shared/commerce.ts'
import {traceKinds,type TraceEvent,type TracePage,type TraceDetails,type TraceKind,type TraceOrderRef,type TraceQuery,type TraceStatus} from '../shared/trace.ts'

const uuid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const initialized=new WeakSet<DatabaseSync>()
const statuses=new Set(['ok','blocked','error','info'])
const sources=new Set(['checkout','manual','excel','history','login'])
const codes=new Set([
  'invalid_quantity','invalid_product','product_unavailable','request_conflict','invalid_request_id','checkout_error',
  'verified','login_required','invalid_login','account_locked','lookup_started','found','line_found','invalid_line',
  'select_line','not_found','timeout','error','matched','conflict','missing_policy','line_review','missing_fact',
  'condition_review','eligible','expired','review','aborted','provider_http','generation_error','unknown',
  'new_message','human_handoff','shutdown','customer_handoff','customer_message','ai_failure','commerce_review',
  'customer_reopened','customer_resolved','agent_claim','agent_resolved','completed','cancelled','discarded','failed','ok',
  'faq_gap','faq_wrong','policy_issue','missing_facts','technical','customer_request','other',
  'replay_required','replay_failed','stale_replay','version_changed','already_published','policy_trial_required',
  'policy_conflict','replay_blocked','stale','invalid','unavailable','not_claimed',
])
const idPattern=/^[^\s@\p{Cc}]{1,64}$/u
const numberFields=new Set(['line','quantity','elapsedMs','orderedAt','revision','passed','total'])
const uuidFields=new Set(['messageId','causeMessageId','caseId'])
type Row=Record<string,SQLOutputValue>

export interface TraceInput {
  kind:TraceKind; conversationId?:string; order?:TraceOrderRef; dedupeKey?:string
  at?:number; status?:TraceStatus; details?:Record<string,string|number|boolean|undefined>
}

export function cardTraceDetails(card:CommerceCard):TraceDetails {
  const versions=card.sources?.map(source=>source.id+'@'+source.version).join('、')
  const line=card.selectedLine
  return {queryKind:card.kind,code:card.status,...(versions && {versions}),...(card.deadline && {deadline:card.deadline}),
    ...(line && {line:line.line,sku:line.sku,quantity:line.quantity})}
}

export function initTraceStore(db:DatabaseSync) {
  if (initialized.has(db)) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS support_trace_meta (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), started_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS support_trace (
      seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, status TEXT NOT NULL,
      at INTEGER NOT NULL, conversation_id TEXT, order_key TEXT, order_id TEXT, shop TEXT, owner TEXT,
      historical INTEGER NOT NULL, details TEXT NOT NULL, dedupe_hash TEXT UNIQUE,
      CHECK (conversation_id IS NOT NULL OR order_key IS NOT NULL)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS trace_session ON support_trace(conversation_id,at,seq);
    CREATE INDEX IF NOT EXISTS trace_short_session ON support_trace(substr(conversation_id,-6));
    CREATE INDEX IF NOT EXISTS trace_order ON support_trace(order_key,conversation_id);
    CREATE INDEX IF NOT EXISTS trace_order_number ON support_trace(order_id,order_key);
    CREATE INDEX IF NOT EXISTS trace_time ON support_trace(at,seq);
    CREATE TRIGGER IF NOT EXISTS trace_no_update BEFORE UPDATE ON support_trace
      BEGIN SELECT RAISE(ABORT,'trace entries are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trace_no_delete BEFORE DELETE ON support_trace
      BEGIN SELECT RAISE(ABORT,'trace entries are immutable'); END;
  `)
  db.prepare('INSERT OR IGNORE INTO support_trace_meta VALUES (1,?)').run(Date.now())
  // DDL performed by a caller inside its own transaction can still be rolled back.
  if (!db.isTransaction) initialized.add(db)
}

function safeDetails(input:NonNullable<TraceInput['details']>={}):TraceDetails {
  const result:TraceDetails={}
  for (const [key,value] of Object.entries(input)) {
    if (typeof value==='number' && numberFields.has(key) && Number.isFinite(value) && value>=0) {
      result[key]=value
    } else if (typeof value==='string') {
      if (uuidFields.has(key) && uuid.test(value)) result[key]=value.toLowerCase()
      else if ((key==='code' || key==='reason') && codes.has(value)) result[key]=value
      else if (key==='source' && sources.has(value)) result[key]=value
      else if (key==='queryKind' && ['order','return','faq'].includes(value)) result[key]=value
      else if (key==='target' && ['faq','policy'].includes(value)) result[key]=value
      else if (key==='sku' && idPattern.test(value)) result[key]=value
      else if (key==='deadline' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) result[key]=value
      else if (key==='versions' && value.length<=8000 && value.split('、').every(ref=>{
        const parts=ref.split('@')
        return parts.length<=2 && parts.every(p=>idPattern.test(p))
      })) result[key]=value
    }
  }
  return result
}

export function appendTrace(db:DatabaseSync,input:TraceInput):string {
  initTraceStore(db)
  const {kind}=input, status=input.status ?? 'ok', at=input.at ?? Date.now()
  const conversationId=input.conversationId?.toLowerCase() ?? null
  if (!Object.hasOwn(traceKinds,kind) || !statuses.has(status) || !Number.isSafeInteger(at) || at<0) throw Error('流程步骤类型、时间或状态无效。')
  if (conversationId!==null && !uuid.test(conversationId)) throw Error('流程会话编号无效。')
  const details=safeDetails(input.details)
  // An attempted lookup is not evidence of ownership. Callers provide order only after verifying it.
  const unverified=['not_found','login_required','invalid_login','account_locked','lookup_started'].includes(String(details.code))
  const order=unverified?undefined:input.order
  if (order && (!order.shop?.trim() || !order.owner?.trim() || !idPattern.test(order.orderId))) throw Error('订单来源编号无效。')
  if (!order && !conversationId) throw Error('步骤必须关联会话或已核验订单。')
  const orderId=order?.orderId.toUpperCase() ?? null
  const orderKey=order?JSON.stringify([order.shop,order.owner,orderId]):null
  const scope=kind.startsWith('order.')?orderKey:conversationId
  const dedupe=input.dedupeKey===undefined?null:createHash('sha256').update(JSON.stringify([kind,scope,input.dedupeKey])).digest('hex')
  const id='EV-'+randomUUID()
  const written=db.prepare(`INSERT INTO support_trace
    (event_id,kind,status,at,conversation_id,order_key,order_id,shop,owner,historical,details,dedupe_hash)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_hash) DO NOTHING`)
    .run(id,kind,status,at,conversationId,orderKey,orderId,order?.shop ?? null,order?.owner ?? null,
      details.source==='history'?1:0,JSON.stringify(details),dedupe)
  return written.changes? id : String(db.prepare('SELECT event_id FROM support_trace WHERE dedupe_hash=?').get(dedupe)!.event_id)
}

function event(row:Row):TraceEvent {
  const conversationId=row.conversation_id as string|null, kind=row.kind as TraceKind
  return {id:String(row.event_id),sequence:Number(row.seq),kind,label:traceKinds[kind],status:row.status as TraceStatus,
    at:Number(row.at),conversationId,flowId:conversationId?'TR-'+conversationId:null,
    order:row.order_key?{orderId:String(row.order_id),shop:String(row.shop),owner:String(row.owner)}:null,
    details:JSON.parse(String(row.details))}
}

// A session includes its own history and its verified orders' source events.
// An order includes each directly linked session, without expanding through other sessions' orders.
const orderSourceKinds="('order.placed','order.recorded','order.imported','order.updated','order.historical')"
function scope(q:string,focus:Row|undefined) {
  const fullFlow=/^TR-/i.test(q) && uuid.test(q.slice(3))
  const id=fullFlow?q.slice(3).toLowerCase():q.toLowerCase()
  const suffix=!fullFlow && /^[a-f\d]{6}$/i.test(q)
  let sessionWhere='0',orderWhere='0'
  const params:SQLInputValue[]=[]
  if (focus) {
    if (focus.order_key && String(focus.kind).startsWith('order.')) {
      orderWhere='order_key=?';params.push(focus.order_key)
    } else {
      sessionWhere='conversation_id=?';params.push(focus.conversation_id)
    }
  } else {
    if (uuid.test(id) || suffix) {
      sessionWhere=suffix?'substr(conversation_id,-6)=?':'conversation_id=?'
      params.push(id)
    }
    if (!fullFlow) {orderWhere='order_id=?';params.push(q.toUpperCase())}
  }
  const cte=`WITH direct_sessions(id) AS (
      SELECT DISTINCT conversation_id FROM support_trace WHERE ${sessionWhere}
    ), direct_orders(order_key) AS (
      SELECT DISTINCT order_key FROM support_trace WHERE ${orderWhere}
    ), flows(id) AS (
      SELECT id FROM direct_sessions UNION
      SELECT conversation_id FROM support_trace JOIN direct_orders USING(order_key) WHERE conversation_id IS NOT NULL
    ), sources(order_key) AS (
      SELECT order_key FROM direct_orders UNION
      SELECT order_key FROM support_trace WHERE conversation_id IN direct_sessions AND order_key IS NOT NULL
    ), relevant(seq) AS (
      SELECT seq FROM support_trace WHERE conversation_id IN flows UNION
      SELECT seq FROM support_trace WHERE order_key IN sources AND kind IN ${orderSourceKinds}
    ) `
  return {cte,params}
}

function legacySession(db:DatabaseSync,q:string,since:number):boolean {
  const id=q.replace(/^TR-/i,'').toLowerCase()
  if (!uuid.test(id) && !/^[a-f\d]{6}$/.test(id)) return false
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='conversations'").get()) return false
  const key=id.length===6?'substr(id,-6)':'id'
  return !!db.prepare(`SELECT 1 FROM conversations WHERE ${key}=? AND created_at<? LIMIT 1`).get(id,since)
}

export function readTrace(db:DatabaseSync,query:TraceQuery={}):TracePage {
  initTraceStore(db)
  const q=(query.q ?? '').trim(), cursor=query.cursor, limit=query.limit ?? 40
  if (q.length>160 || !Number.isInteger(limit) || limit<1 || limit>100 ||
    (cursor!==undefined && (!Number.isSafeInteger(cursor) || cursor<1))) throw Error('请核对查询编号或分页范围。')
  const coverageSince=Number(db.prepare('SELECT started_at FROM support_trace_meta WHERE singleton=1').get()!.started_at)
  const result:TracePage={query:q,events:[],nextCursor:null,coverageSince,legacy:false,matched:false}
  let focus:Row|undefined
  if (/^EV-/i.test(q) && uuid.test(q.slice(3))) {
    focus=db.prepare('SELECT * FROM support_trace WHERE event_id=?').get('EV-'+q.slice(3).toLowerCase())
    if (!focus) return result
    result.selectedEvent=event(focus)
  }
  const {cte,params}=q?scope(q,focus):{cte:'',params:[]}
  const where=q?'seq IN relevant':'1'
  const direction=q?'ASC':'DESC', op=q?'>':'<'
  const after=cursor===undefined?'':` AND (at,seq) ${op} (SELECT at,seq FROM support_trace WHERE seq=?)`
  const rows=db.prepare(`${cte}SELECT * FROM support_trace WHERE ${where}${after} ORDER BY at ${direction},seq ${direction} LIMIT ?`)
    .all(...params,...(cursor===undefined?[]:[cursor]),limit+1)
  result.events=rows.slice(0,limit).map(event)
  if (rows.length>limit) result.nextCursor=result.events[limit-1].sequence
  result.legacy=q
    ? !!db.prepare(`${cte}SELECT 1 FROM support_trace WHERE ${where} AND historical=1 LIMIT 1`).get(...params) ||
      legacySession(db,focus?.conversation_id ? String(focus.conversation_id):q,coverageSince)
    : result.events.some(e=>e.details.source==='history')
  result.matched=!!rows.length || result.legacy || !!focus ||
    (cursor!==undefined && !!db.prepare(`${cte}SELECT 1 FROM support_trace WHERE ${where} LIMIT 1`).get(...params))
  return result
}
