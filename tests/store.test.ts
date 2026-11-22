import assert from 'node:assert/strict'
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStore } from '../server/store.ts'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { readTrace } from '../server/trace-store.ts'

test('a rolled-back message and a failed login leave no committed trace steps', () => {
  const store=openStore(':memory:')
  try {
    assert.throws(()=>store.create(()=>{throw Error('login failed')}),/login failed/)
    assert.equal(readTrace(store.database,{}).events.length,0)
    const {id}=store.create()
    assert.throws(()=>store.append(id,'assistant','临时答复',{nextMode:'waiting',onApplied(){throw Error('save failed')}}),/save failed/)
    assert.equal(store.snapshot(id)?.messages.length,0)
    assert.deepEqual(readTrace(store.database,{q:id}).events.map(e=>e.kind),['session.created'])
  } finally {store.close()}
})

test('upgrades the old mode constraint while preserving credentials, linked records and handoff history', () => {
  const directory = mkdtempSync(join(tmpdir(),'support-legacy-'))
  const filename = join(directory,'support.sqlite')
  const legacy = new DatabaseSync(filename)
  const id = '00000000-0000-4000-8000-123456abcdef'
  const token = 'a'.repeat(43)
  legacy.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY, token_hash BLOB NOT NULL,
    mode TEXT NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai','waiting','human')), version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,handoff_reason TEXT NOT NULL DEFAULT '') STRICT;
    CREATE TABLE linked_feedback(id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id));`)
  legacy.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,?)').run(id,createHash('sha256').update(token).digest(),'human',4,1,2,'原转接原因')
  legacy.prepare('INSERT INTO linked_feedback VALUES(?,?)').run('case-1',id)
  legacy.close()
  const store = openStore(filename)
  try {
    assert.equal(store.authenticate(id,token),true)
    assert.equal(store.snapshot(id)?.handoffReason,'原转接原因')
    assert.equal(store.resolve(id,4),'applied')
    assert.equal(store.database.prepare('SELECT conversation_id FROM linked_feedback').get()?.conversation_id,id)
    assert.equal(store.database.prepare('PRAGMA foreign_key_check').get(),undefined)
    assert.equal(store.database.prepare('PRAGMA foreign_keys').get()?.foreign_keys,1)
  } finally {store.close()}
  const resumed = openStore(filename)
  try {
    assert.equal(resumed.listQueue(true)[0].mode,'resolved')
    assert.equal(resumed.diagnosticSession(id)?.lifecycle[0].kind,'resolved')
  } finally {resumed.close(); unlinkSync(filename); rmdirSync(directory)}
})

test('customer credentials are specific to a conversation and survive restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'support-store-'))
  const filename = join(directory, 'support.sqlite')
  const initial = openStore(filename)
  const first = initial.create()
  const second = initial.create()
  initial.append(first.id, 'customer', '你好', { requestId: 'request-1', nextMode: 'waiting' })
  const before = initial.snapshot(first.id)
  initial.close()

  const reopened = openStore(filename)
  try {
    assert.equal(reopened.authenticate(first.id, second.token), false)
    assert.equal(reopened.authenticate(first.id, first.token), true)
    assert.deepEqual(reopened.snapshot(first.id), before)
    assert.equal(reopened.snapshot(first.id)?.mode, 'waiting')
    assert.deepEqual(reopened.listQueue().map((conversation) => conversation.id), [first.id])
    assert.equal(reopened.append(first.id, 'customer', '你好', { requestId: 'request-1' }), 'duplicate')
    assert.equal(reopened.snapshot(first.id)?.messages.length, 1)
  } finally {
    reopened.close()
    unlinkSync(filename)
    rmdirSync(directory)
  }
})
