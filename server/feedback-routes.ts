import express from 'express'
import { z } from 'zod'
import { feedbackReasons, type FeedbackCase, type FeedbackReason } from '../shared/feedback.ts'
import { FeedbackError, type openFeedback } from './feedback-store.ts'
import { log } from './log.ts'
import { staffAccess } from './staff-access.ts'

const id = z.uuid()
const version = z.number().int().positive()
const captureBody = z.object({
  conversationId:id, messageId:z.union([id,z.literal('')]),
  reason:z.custom<FeedbackReason>(value => typeof value === 'string' && Object.hasOwn(feedbackReasons,value)),
  note:z.string().max(2000).optional(),
  expected:z.discriminatedUnion('kind', [
    z.object({kind:z.literal('faq'),answer:z.string().trim().min(1).max(8000)}),
    z.object({kind:z.literal('policy'),status:z.enum(['eligible','expired','review']),
      versions:z.array(z.string().max(129)).max(50).optional(),deadline:z.string().length(19).nullable().optional()}),
    z.object({kind:z.literal('none')}),
  ]),
})
const draftBody = z.object({
  expectedVersion:version, kind:z.enum(['faq','policy']), row:z.record(z.string(),z.string().max(8000)),
  orderIds:z.array(z.string().trim().min(1).max(64)).length(2).optional(),
  contrastQuestions:z.array(z.string().trim().min(1).max(300)).max(20).optional(),
})
type FeedbackStore = ReturnType<typeof openFeedback>

function traceFields(item:FeedbackCase) {
  const replay = item.replay
  const passed = replay?.rows.filter(row => row.passed).length ?? 0
  const policyMismatches = replay?.rows.flatMap(row => row.checks?.filter(check => !check.passed)
    .map(({field,expected,actual}) => ({caseId:row.caseId,field,expected,actual})) ?? []).slice(0,30)
  return {
    conversationId:item.conversationId, caseId:item.id, reasonCode:item.reason,
    ...(item.draft && item.draftVersion ? {target:item.draft.kind, revisionId:item.draftVersion} : {}),
    ...(replay ? {passed, total:replay.rows.length} : {}),
    ...(policyMismatches?.length ? {policyMismatches} : {}),
    ...(replay && !replay.passed ? {replayIssue:replay.faqContrasts?.some(check=>!check.passed) ? 'faq_contrast' : passed < replay.rows.length ? 'case_mismatch' : 'policy_trial'} : {}),
  }
}

export function feedbackRoutes(store:FeedbackStore, key:string|undefined, changed:() => void) {
  const router = express.Router()
  const allowed = staffAccess(key)
  router.use((req, res, next) => {
    res.set('Cache-Control','no-store')
    if (!allowed(req.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1])) {
      res.status(401).json({errors:['请先在坐席工作台输入坐席密钥，再查看内部反馈。']})
      return
    }
    next()
  })
  router.use(express.json({limit:'100kb'}))
  router.get('/', (req,res) => {
    const query = req.query.conversationId
    if (query !== undefined && !id.safeParse(query).success) {
      res.status(400).json({errors:['会话编号无效。']})
      return
    }
    res.json({cases:store.list(query as string|undefined)})
  })
  router.post('/capture', (req,res) => {
    const data = captureBody.safeParse(req.body)
    if (!data.success) {
      res.status(400).json({errors:['请选择顾客原话、转人工原因，并填写对应的预期结果。']})
      return
    }
    const {conversationId,...input} = data.data
    const existing = store.list(conversationId).some(entry => entry.messageId === input.messageId)
    const item = store.capture(conversationId,input)
    if (!existing) {
      log('feedback','case_recorded',traceFields(item))
      changed()
    }
    res.json({item})
  })
  router.param('caseId',(req,res,next,value:string) => {
    if (!id.safeParse(value).success) { res.status(400).json({errors:['反馈案例编号无效。']}); return }
    next()
  })
  router.post('/:caseId/draft',(req,res) => {
    const data = draftBody.safeParse(req.body)
    if (!data.success) {
      res.status(400).json({errors:['请核对修订版本、资料内容和试算订单。']})
      return
    }
    const {expectedVersion,...draft} = data.data
    const item = store.saveDraft(req.params.caseId,draft,expectedVersion)
    log('feedback','revision_saved',traceFields(item))
    changed()
    res.json({item})
  })
  router.post(['/:caseId/replay','/:caseId/publish'],(req,res) => {
    const parsed = version.safeParse(req.body?.expectedVersion)
    if (!parsed.success) { res.status(400).json({errors:['请刷新反馈案例，核对当前修订版本。']}); return }
    const caseId = String(req.params.caseId)
    const publishing = req.path.endsWith('/publish')
    const previous = publishing ? store.get(caseId) : null
    try {
      const item = publishing ? store.publish(caseId,parsed.data) : store.replay(caseId,parsed.data)
      if (previous?.status !== 'published') {
        log('feedback',publishing ? 'publish_succeeded' : item.replay?.passed ? 'replay_passed' : 'replay_failed',traceFields(item))
        changed()
      }
      res.json({item})
    } catch (err) {
      if (publishing && err instanceof FeedbackError) {
        const item = store.get(caseId)
        if (item) {
          let cause = 'replay_required'
          if (item.status === 'published') cause = 'already_published'
          else if (err.code === 'stale') cause = previous?.version === parsed.data ? 'stale_replay' : 'version_changed'
          else if (err.code === 'replay_blocked') cause = 'replay_failed'
          log('feedback','publish_blocked',{...traceFields(item),blockReason:cause})
          changed()
        }
      }
      throw err
    }
  })
  router.use((err:Error & {type?:string},_req:express.Request,res:express.Response,next:express.NextFunction) => {
    if (err instanceof FeedbackError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'invalid' ? 422 : 409
      res.status(status).json({errors:[err.message],code:err.code})
    } else if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      res.status(err.type === 'entity.too.large' ? 413 : 400).json({errors:['反馈表单格式或大小无效。']})
    } else next(err)
  })
  return router
}
