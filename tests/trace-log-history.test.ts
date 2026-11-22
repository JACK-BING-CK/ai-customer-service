import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {test} from 'node:test'
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openStore} from '../server/store.ts'
import {readTrace} from '../server/trace-store.ts'
import {importLegacyServiceLog} from '../server/trace-log-history.ts'

test('migrates only available service observations once and keeps missing, private or later events out',async()=>{
  const store=openStore(':memory:'), db=store.database
  const dir=mkdtempSync(join(tmpdir(),'support-log-')),path=join(dir,'service.jsonl')
  try {
    const session=randomUUID(),other=randomUUID(),caseId=randomUUID()
    const start=readTrace(db,{}).coverageSince
    db.prepare('INSERT INTO conversations(id,token_hash,created_at,updated_at) VALUES (?,?,?,?)').run(session,Buffer.alloc(32),start-12000,start)
    db.exec('CREATE TABLE feedback_cases(id TEXT PRIMARY KEY,conversation_id TEXT)')
    db.prepare('INSERT INTO feedback_cases VALUES(?,?)').run(caseId,session)
    const line=(module:string,event:string,extra={})=>JSON.stringify({
      at:new Date(start-5000).toISOString(),module,event,conversationId:session,...extra})
    await importLegacyServiceLog(db,path)
    writeFileSync(path,[
      line('session','created'),line('ai','generation_started'),line('ai','generation_failed',{kind:'timeout',secret:'secret-sample'}),
      line('ai','generation_completed'),line('conversation','mode_changed',{mode:'waiting',reason:'ai_failure'}),
      line('conversation','mode_changed',{mode:'human',reason:'agent_claim'}),line('conversation','mode_changed',{mode:'resolved',reason:'agent_resolved'}),
      line('policy','matched',{version:'V2',elapsedMs:4,orderId:'FOREIGN-GUESS'}),line('orders','not_found',{orderId:'FOREIGN-GUESS'}),
      line('feedback','revision_saved',{caseId,target:'policy',revisionId:2}),line('feedback','replay_failed',{caseId,passed:1,total:2}),
      line('feedback','publish_blocked',{caseId,blockReason:'replay_failed'}),line('feedback','publish_succeeded',{caseId}),
      line('ai','generation_cancelled',{reason:'shutdown',conversationId:other}),line('ai','generation_started',{at:new Date(start+10).toISOString()}),
      line('ai','generation_started',{at:new Date(start-20000).toISOString()}),line('feedback','revision_saved',{caseId:other}),
      line('orders','found',{conversationId:''}),'{damaged line','null',line('unknown','untrusted'),
    ].join('\n'))
    await importLegacyServiceLog(db,path)
    const before=readTrace(db,{q:session}).events
    assert.deepEqual(before.map(e=>e.kind),['ai.started','ai.failed','handoff.waiting','agent.claimed','policy.lookup','orders.lookup','feedback.draft','feedback.replayed','feedback.publish_blocked'])
    assert.ok(before.every(e=>e.details.source==='history' && !e.order))
    assert.equal(before[1].details.code,'timeout')
    assert.equal(before[4].details.versions,'V2')
    assert.equal(before[5].status,'blocked')
    assert.equal(before[7].details.total,2)
    assert.doesNotMatch(JSON.stringify(before),/secret-sample|FOREIGN-GUESS/)
    await importLegacyServiceLog(db,path)
    assert.deepEqual(readTrace(db,{q:session}).events,before)
  } finally {store.close();unlinkSync(path);rmdirSync(dir)}
})
