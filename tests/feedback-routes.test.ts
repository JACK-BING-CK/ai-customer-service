import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import express from 'express'
import { feedbackRoutes } from '../server/feedback-routes.ts'
import { openStore } from '../server/store.ts'
import { openCommerce } from '../server/commerce.ts'
import { openMerchant } from '../server/merchant-store.ts'
import { openFeedback } from '../server/feedback-store.ts'

test('feedback routes respect the optional seat key and reject malformed or stale submissions', async t => {
  const store = openStore(':memory:')
  openCommerce(store.database)
  const feedback = openFeedback(store.database, openMerchant(store.database))
  const session = store.create()
  store.append(session.id, 'customer', '售后补寄需要运费吗？')
  store.setMode(session.id, 'ai', 'waiting')
  store.setMode(session.id, 'waiting', 'human')
  const app = express()
  app.use('/api/feedback', feedbackRoutes(feedback, 'test-seat', () => {}))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close() })
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  const url = 'http://127.0.0.1:' + addr.port + '/api/feedback'
  const headers = {Authorization:'Bearer test-seat','Content-Type':'application/json'}
  const post = (path:string, body:unknown) => fetch(url + path, {method:'POST',headers,body:JSON.stringify(body)})
  assert.equal((await fetch(url)).status, 401)
  assert.equal((await fetch(url, {headers:{Authorization:'Bearer ' + session.token}})).status, 401)
  assert.deepEqual(await (await fetch(url, {headers})).json(), {cases:[]})
  assert.equal((await fetch(url + '?conversationId=bad', {headers})).status, 400)
  assert.equal((await post('/capture', {})).status, 400)
  const capture = await post('/capture', {conversationId:session.id,messageId:store.snapshot(session.id)!.messages[0].id,
    reason:'faq_gap',expected:{kind:'faq',answer:'店铺承担补寄运费。'}})
  assert.equal(capture.status, 200)
  const {item} = await capture.json()
  assert.equal(item.question, '售后补寄需要运费吗？')
  assert.equal((await post('/' + item.id + '/replay', {})).status, 400)
  assert.equal((await post('/' + item.id + '/publish', {expectedVersion:item.version + 10})).status, 409)
  const scoped = await (await fetch(url + '?conversationId=' + session.id, {headers})).json()
  assert.deepEqual(scoped.cases.map((c:{id:string}) => c.id), [item.id])
})
