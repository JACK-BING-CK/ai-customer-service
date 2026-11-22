import {randomUUID} from 'node:crypto'
import {open} from 'node:fs/promises'
import {createInterface} from 'node:readline'
import type {DatabaseSync} from 'node:sqlite'
import {businessEvent} from './diagnostic-commerce.ts'
import {appendTrace,initTraceStore,type TraceInput} from './trace-store.ts'
import type {TraceDetails,TraceKind,TraceStatus} from '../shared/trace.ts'

const migration='legacy-service-log-v1'
const uuid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const steps={identity:'identity.checked',orders:'orders.lookup',policy:'policy.lookup',eligibility:'eligibility.checked'} as const
const okBusiness=new Set(['verified','found','line_found','matched','expired','eligible'])
const queueReasons=new Set(['customer_handoff','customer_message','ai_failure','commerce_review'])
const cancelledReasons=new Set(['new_message','human_handoff','shutdown'])

function parseObservation(line:string,cutoff:number):TraceInput|undefined {
  let row:Record<string,unknown>
  try {row=JSON.parse(line)} catch {return}
  if (!row || typeof row!=='object' || typeof row.conversationId!=='string' || !uuid.test(row.conversationId) ||
      typeof row.module!=='string' || typeof row.event!=='string' || typeof row.at!=='string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.at)) return
  const at=Date.parse(row.at)
  if (!Number.isSafeInteger(at) || at<0 || at>cutoff) return
  const details:TraceDetails={source:'history'}
  let kind:TraceKind,status:TraceStatus='ok'
  if (Object.hasOwn(steps,row.module)) {
    const code=row.event
    if (!businessEvent(row.module,code,undefined,undefined)) return
    kind=steps[row.module as keyof typeof steps]
    status=code==='lookup_started'?'info':code==='timeout' || code==='error'?'error':okBusiness.has(code)?'ok':'blocked'
    details.code=code
    if (typeof row.elapsedMs==='number' && row.elapsedMs>=0 && row.elapsedMs<86400000) details.elapsedMs=row.elapsedMs
    if (['policy','eligibility'].includes(row.module) && typeof row.version==='string' && /^[^\s@\p{Cc}]{1,64}$/u.test(row.version)) details.versions=row.version
  } else if (row.module==='conversation' && row.event==='mode_changed') {
    if (row.mode==='human' && row.reason==='agent_claim') kind='agent.claimed'
    else if (row.mode==='waiting' && typeof row.reason==='string' && queueReasons.has(row.reason)) kind='handoff.waiting'
    else return
    details.code=String(row.reason)
  } else if (row.module==='feedback') {
    if (typeof row.caseId!=='string' || !uuid.test(row.caseId)) return
    if (row.event==='revision_saved') kind='feedback.draft'
    else if (row.event==='replay_failed' || row.event==='replay_passed') kind='feedback.replayed'
    else if (row.event==='publish_blocked') kind='feedback.publish_blocked'
    else return
    status=row.event==='publish_blocked' || row.event==='replay_failed'?'blocked':'ok'
    details.caseId=row.caseId.toLowerCase()
    if (row.target==='faq' || row.target==='policy') details.target=row.target
    if (typeof row.revisionId==='number' && Number.isSafeInteger(row.revisionId) && row.revisionId>0) details.revision=row.revisionId
    if (typeof row.total==='number' && Number.isSafeInteger(row.total) && typeof row.passed==='number' &&
        Number.isSafeInteger(row.passed) && row.passed>=0 && row.passed<=row.total) {
      details.total=row.total;details.passed=row.passed
    }
    if (typeof row.blockReason==='string' && ['replay_required','replay_failed','stale_replay','version_changed','already_published'].includes(row.blockReason)) details.reason=row.blockReason
  } else {
    switch (row.module+'.'+row.event) {
      case 'ai.generation_started': kind='ai.started';status='info';break
      case 'commerce.started': kind='commerce.started';status='info';break
      case 'ai.generation_failed': kind='ai.failed';status='error'
        details.code=typeof row.kind==='string' && ['provider_http','aborted','generation_error','timeout'].includes(row.kind)?row.kind:'unknown'
        break
      case 'commerce.failed': kind='commerce.failed';status='error';details.code='error';break
      case 'ai.generation_cancelled':
      case 'commerce.cancelled':
        kind=row.module==='ai'?'ai.cancelled':'commerce.cancelled';status='info'
        if (typeof row.reason==='string' && cancelledReasons.has(row.reason)) details.code=row.reason
        break
      case 'ai.generation_discarded': kind='ai.cancelled';status='info';details.code='discarded';break
      default:return
    }
  }
  return {kind,status,at,conversationId:row.conversationId.toLowerCase(),details}
}

export async function importLegacyServiceLog(db:DatabaseSync,path:string):Promise<void> {
  initTraceStore(db)
  db.exec('CREATE TABLE IF NOT EXISTS trace_migrations (name TEXT PRIMARY KEY) STRICT')
  const done=db.prepare('SELECT 1 FROM trace_migrations WHERE name=?')
  if (done.get(migration)) return
  const file=await open(path,'r').catch((error:NodeJS.ErrnoException)=>{
    if (error.code==='ENOENT') return null
    throw error
  })
  if (!file) return
  const stage='trace_log_'+randomUUID().replaceAll('-','')
  try {
    const size=(await file.stat()).size
    if (!size) return
    const cutoff=Number(db.prepare('SELECT started_at FROM support_trace_meta WHERE singleton=1').get()!.started_at)
    const known=db.prepare('SELECT 1 FROM conversations WHERE id=? AND created_at<=?')
    const caseExists=db.prepare('SELECT 1 FROM feedback_cases WHERE id=? AND conversation_id=?')
    // Stage just the allowed metadata locally. No writer lock is held while awaiting filesystem I/O.
    db.exec(`CREATE TEMP TABLE ${stage}(payload TEXT NOT NULL)`)
    const stageEntry=db.prepare(`INSERT INTO ${stage} VALUES (?)`)
    const input=file.createReadStream({encoding:'utf8',autoClose:false,end:size-1})
    const lines=createInterface({input,crlfDelay:Infinity})
    try {
      for await (const line of lines) {
        const item=parseObservation(line,cutoff)
        if (!item || !known.get(item.conversationId!,item.at!)) continue
        const caseId=item.details?.caseId
        if (typeof caseId==='string' && !caseExists.get(caseId,item.conversationId!)) continue
        stageEntry.run(JSON.stringify(item))
      }
    } finally {lines.close();input.destroy()}
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!done.get(migration)) {
        for (const row of db.prepare(`SELECT payload FROM ${stage} ORDER BY rowid`).iterate()) {
          appendTrace(db,JSON.parse(String(row.payload)) as TraceInput)
        }
        db.prepare('INSERT INTO trace_migrations VALUES (?)').run(migration)
      }
      db.exec('COMMIT')
    } catch (error) {db.exec('ROLLBACK');throw error}
  } finally {
    try {db.exec(`DROP TABLE IF EXISTS temp.${stage}`)} finally {await file.close()}
  }
}
