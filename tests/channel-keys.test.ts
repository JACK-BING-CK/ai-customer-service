import assert from 'node:assert/strict'
import {mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {openStore} from '../server/store.ts'
import {openChannelKeys} from '../server/channel-keys.ts'

test('channel keys share the support database, survive restarts and never appear in listings or disk files',()=>{
  const directory=mkdtempSync(join(tmpdir(),'support-channels-'))
  const path=join(directory,'sessions.sqlite')
  const first=openStore(path)
  const second=openStore(path)
  try {
    const admin=openChannelKeys(first.database)
    const api=openChannelKeys(second.database)
    const session=first.create()
    const left=admin.create('shop-web','店铺网页')
    const right=admin.create('shop-app','手机商城')
    assert.ok(left.key!==right.key)
    assert.deepEqual(api.authenticate(left.key),{id:'shop-web',name:'店铺网页'})
    assert.deepEqual(api.authenticate(right.key),{id:'shop-app',name:'手机商城'})
    for(const input of [null,undefined,{},'',left.key+'x','X'.repeat(5000)]){
      assert.equal(api.authenticate(input),null)
    }
    assert.throws(()=>admin.create('shop-web','店铺网页'),{status:409})
    assert.throws(()=>admin.create('shop-web','其他入口'),{status:409})
    assert.deepEqual(api.authenticate(left.key),{id:'shop-web',name:'店铺网页'})
    const next=admin.rotate('shop-web')
    assert.equal(api.authenticate(left.key),null)
    assert.deepEqual(api.authenticate(next.key),{id:'shop-web',name:'店铺网页'})
    assert.deepEqual(admin.list(),[
      {id:'shop-app',name:'手机商城',enabled:true},{id:'shop-web',name:'店铺网页',enabled:true}
    ])
    assert.deepEqual(admin.disable('shop-web'),{id:'shop-web',name:'店铺网页',enabled:false})
    assert.deepEqual(admin.disable('shop-web'),{id:'shop-web',name:'店铺网页',enabled:false})
    assert.equal(api.authenticate(next.key),null)
    assert.throws(()=>admin.create('shop-web','重新开户'),{status:409})
    assert.throws(()=>admin.rotate('shop-web'),{status:409})
    assert.throws(()=>admin.disable('missing'),{status:404})
    assert.throws(()=>admin.rotate('missing'),{status:404})
    const reopened=openStore(path)
    try {
      const saved=openChannelKeys(reopened.database)
      assert.deepEqual(saved.authenticate(right.key),{id:'shop-app',name:'手机商城'})
      assert.equal(saved.authenticate(left.key),null)
      assert.equal(saved.authenticate(next.key),null)
      assert.equal(saved.list().length,2)
      assert.equal(reopened.authenticate(session.id,session.token),true)
      for(const file of readdirSync(directory)) {
        const bytes=readFileSync(join(directory,file))
        assert.ok([left.key,right.key,next.key].every(key=>!bytes.includes(Buffer.from(key))))
      }
    } finally {reopened.close()}
  } finally {
    second.close();first.close()
    for(const name of readdirSync(directory)) unlinkSync(join(directory,name))
    rmdirSync(directory)
  }
})

test('invalid channel IDs and missing or invisible display names cannot create a channel or issue a key',()=>{
  const store=openStore(':memory:')
  const keys=openChannelKeys(store.database)
  try {
    for(const id of ['','../shop','..','A-Shop',' shop','a--b','a-','z'.repeat(64),'x\n']) {
      assert.throws(()=>keys.create(id,'新店'),{status:400})
    }
    for(const name of ['', '  ', 'A\nB', 'A\u202eB', '店'.repeat(81)]) {
      assert.throws(()=>keys.create('shop',name),{status:400})
    }
    assert.deepEqual(keys.list(),[])
  } finally {store.close()}
})
