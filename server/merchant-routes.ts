import express from 'express'
import { createHmac, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { merchantFields, merchantRowKey, merchantKinds, merchantSheetNames, type MerchantKind, type MerchantRow, type PolicyConflict } from '../shared/merchant.ts'
import { openMerchant, PolicyConflictError } from './merchant-store.ts'
import { merchantTemplatePath, merchantUploadLimit, parseMerchantWorkbook } from './merchant-xlsx.ts'
import { log } from './log.ts'

export function merchantRoutes(db: DatabaseSync, store = openMerchant(db)) {
  const router = express.Router()
  const previewSecret = randomBytes(32)
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })

  router.get('/', (_req, res) => res.json({data:store.list(), fields:merchantFields, publications:store.publicationKeys()}))
  router.get('/publication', (req, res) => {
    const key = req.query.policyKey
    const saved = typeof key === 'string' && key.length <= 180 ? store.publication(key) : null
    if (!saved) { res.status(404).json({ok:false,errors:['没有找到这个版本的发布试算记录。']}); return }
    res.json(saved)
  })
  router.get('/template', (_req, res) => res.download(merchantTemplatePath, '店铺客服资料录入模板.xlsx'))
  router.post('/save', express.json({limit:'100kb'}), (req, res) => {
    const {kind, row, original} = req.body ?? {}
    if (!merchantKinds.includes(kind) || !validRow(kind, row) || (original !== undefined && !validRow(kind, original))) {
      res.status(400).json({ok:false, errors:['资料格式有误，请刷新页面并重新填写。']})
      return
    }
    const category = kind as MerchantKind
    const key = merchantRowKey(category, row)
    const current = store.list()[category].find(item => merchantRowKey(category, item) === key)
    if (original && (!current || !merchantFields[category].every(key => (current[key] ?? '') === (original[key] ?? '')))) {
      res.status(409).json({ok:false, errors:['这条资料已被其他窗口修改。请刷新列表，核对最新内容后再保存。']})
      return
    }
    if (!original && current && merchantFields[category].some(key => (current[key] ?? '') !== (row[key]?.trim() ?? ''))) {
      res.status(409).json({ok:false, errors:['这个编号已存在，请在资料列表中打开对应记录进行编辑。']})
      return
    }
    const result = store.apply({[kind]:[row]}, true)
    if (result.ok) log('merchant','saved',{category:kind,changes:result.changes})
    res.status(result.ok ? 200 : 422).json(result)
  })

  router.post(['/import/preview','/import/commit'], express.raw({type:'application/octet-stream', limit:merchantUploadLimit}), async (req, res) => {
    const commit = req.path.endsWith('/commit')
    const blocked = commit ? 'import_commit_blocked' : 'import_preview_blocked'
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      res.status(400).json({ok:false,errors:['请选择一份 .xlsx 模板文件。']})
      return
    }
    let rows
    try { rows = await parseMerchantWorkbook(req.body) }
    catch (error) {
      log('merchant', blocked)
      res.status(422).json({ok:false,errors:[error instanceof Error ? error.message : '无法读取 Excel 文件。']})
      return
    }
    const counts = Object.fromEntries(merchantKinds.map(kind => [kind, rows[kind]?.length ?? 0]))
    const samples = Object.fromEntries(merchantKinds.map(kind => [kind, (rows[kind] ?? []).slice(0,3)]))
    // The confirmation covers exactly the file and shop data the operator previewed.
    const previewToken = createHmac('sha256', previewSecret).update(req.body).update(JSON.stringify(store.list())).digest('hex')
    if (commit && previewToken !== req.get('X-Import-Preview')) {
      res.status(409).json({ok:false,errors:['文件或店铺资料已变化，请重新预览再导入。']})
      return
    }
    const result = store.apply(rows, commit, undefined, {source:'excel'})
    if (!result.ok) {
      log('merchant',blocked,{sheet:merchantSheetNames.orders,rows:result.importIssues.map(issue=>issue.row)})
    } else if (commit) log('merchant','imported',{changes:result.changes})
    res.status(result.ok ? 200 : 422).json({...result, counts, samples, ...(result.ok && !commit ? {previewToken} : {})})
  })

  router.post(['/trial','/publish'], express.json({limit:'4kb'}), (req, res) => {
    const {policyKey, orderIds, token} = req.body ?? {}
    const publish = req.path === '/publish'
    if (typeof policyKey !== 'string' || !policyKey || policyKey.length > 180 ||
        !Array.isArray(orderIds) || orderIds.length !== 2 ||
        !orderIds.every(id => typeof id === 'string' && id.trim() && id.length <= 64) ||
        (publish && (typeof token !== 'string' || !token || token.length > 256))) {
      res.status(400).json({ok:false,errors:['请选择政策草稿和两笔不同的订单，先试算再发布。']})
      return
    }
    try {
      const result = publish ? store.publish(policyKey, orderIds, token) : store.trial(policyKey, orderIds)
      if (!publish && result.conflicts.length) logPolicyBlock('policy_trial_blocked', result.conflicts)
      else log('merchant', publish ? 'policy_published' : 'policy_trial', {orders:orderIds.length})
      res.json({ok:true, ...result})
    } catch (error) {
      if (!(error instanceof Error) || 'code' in error) throw error
      if (error instanceof PolicyConflictError) logPolicyBlock('policy_publish_blocked', error.conflicts)
      res.status(publish ? 409 : 422).json({ok:false,errors:[error.message]})
    }
  })
  router.use((error: Error & {type?:string}, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error.type === 'entity.too.large') res.status(413).json({ok:false,errors:['文件或表单超过大小限制，Excel 文件最多 5 MB。']})
    else if (error.type === 'entity.parse.failed') res.status(400).json({ok:false,errors:['表单格式有误，请重新提交。']})
    else next(error)
  })
  return router
}

function logPolicyBlock(event: 'policy_trial_blocked' | 'policy_publish_blocked', conflicts: PolicyConflict[]) {
  // Keep one bounded log line per operation, with the full count for unusually large shops.
  log('merchant',event,{conflicts:conflicts.slice(0,50), conflictCount:conflicts.length})
}

function validRow(kind: MerchantKind, row: unknown): row is MerchantRow {
  return !!row && typeof row === 'object' && !Array.isArray(row) &&
    Object.entries(row).every(([key, value]) => merchantFields[kind].includes(key) && typeof value === 'string')
}
