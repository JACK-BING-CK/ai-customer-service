import { createHmac, randomBytes } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { MerchantImportIssue } from '../shared/merchant.ts'
import { describePolicyConflict, merchantFields, merchantKinds, merchantRowKey, merchantRowNumber, merchantSheetNames, type MerchantKind, type MerchantRow, type MerchantRows, type PolicyConflict } from '../shared/merchant.ts'
import { DEMO_NOW, demoFaqs, type DemoFaq, type DemoOrder, type ReturnPolicy } from './commerce-fixtures.ts'
import { matchPolicies, replayPolicyChange, storeTime } from './commerce-rules.ts'
import { cleanRow, faqRow, identifier, orderRows, parseFaq, parseOrderRow, parsePolicy, policyRow, requireValues } from './merchant-records.ts'
import { appendTrace, initTraceStore } from './trace-store.ts'

type OrderEntry = {source:'manual'|'excel'} | {source:'checkout';conversationId:string}

function record<T>(row:Record<string,SQLOutputValue> | undefined):T|undefined {
  return row ? JSON.parse(row.payload as string) as T : undefined
}
class UnknownProductSkuError extends Error {
  constructor() { super('成交商品编码未登记，请先录入商品或在同一次导入中提供商品资料。') }
}
function equalRows(a:MerchantRow,b:MerchantRow,ignore='') {
  return Object.keys(a).every(k=> k===ignore || a[k]===b[k])
}
function sameScope(rule:ReturnPolicy, other:ReturnPolicy) {
  return rule.shop===other.shop && rule.channel===other.channel && rule.campaign===other.campaign
}

export class PolicyConflictError extends Error {
  readonly conflicts: PolicyConflict[]
  constructor(conflicts: PolicyConflict[]) {
    super(conflicts.map(describePolicyConflict).join(' '))
    this.conflicts = conflicts
  }
}

// The supplied workbook illustrates one FAQ in different wording from the original v2 demo.
// Only that exact sample may be skipped without treating this as a conflicting business record.
function isWorkbookExample(faq:DemoFaq, prior:DemoFaq) {
  return prior.id==='FAQ-RET-01' && prior.version==='F1' && prior.text===demoFaqs[0].text &&
    faq.title==='怎样办理退货？' && faq.aliasText==='退货怎么申请？／如何退货？' && faq.published &&
    faq.text==='选择本人订单查看退货资格与适用条款；需要协助时，可在同一窗口转人工。' && faq.reference==='店铺退货办理说明'
}

/** Shares the SQLite connection initialized by openCommerce. All previews roll back the entire batch. */
export function openMerchant(db:DatabaseSync) {
  initTraceStore(db)
  const secret=randomBytes(32)
  db.exec('CREATE TABLE IF NOT EXISTS merchant_publications (id TEXT NOT NULL, version TEXT NOT NULL, token TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(id,version)) STRICT')
  db.exec('CREATE TABLE IF NOT EXISTS merchant_feedback_targets (case_id TEXT PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL, UNIQUE(kind,id,version)) STRICT')
  const reservation=db.prepare('SELECT case_id FROM merchant_feedback_targets WHERE kind=? AND id=? AND version=?')
  function guardTarget(kind:string,id:string,version:string,caseId?:string) {
    const target=reservation.get(kind,id,version)
    if (target && target.case_id!==caseId) throw Error('此反馈修订须在运营反馈中完成历史案例回放后发布。')
  }
  function beginWrite() {
    const nested=db.isTransaction
    db.exec(nested?'SAVEPOINT merchant_write':'BEGIN IMMEDIATE')
    return (commit:boolean)=>{
      if (nested) {
        if (!commit) db.exec('ROLLBACK TO merchant_write')
        db.exec('RELEASE merchant_write')
      } else db.exec(commit?'COMMIT':'ROLLBACK')
    }
  }
  const orders=db.prepare('SELECT payload FROM commerce_orders WHERE id=?')
  const getPolicy=db.prepare('SELECT payload FROM commerce_policies WHERE id=? AND version=?')
  const getFaq=db.prepare('SELECT payload FROM commerce_faq WHERE id=? AND version=?')
  const getProduct=db.prepare('SELECT payload FROM commerce_products WHERE sku=?')
  const allPolicies=()=>db.prepare('SELECT payload FROM commerce_policies ORDER BY id,version').all().map(r=>record<ReturnPolicy>(r)!)
  const savePolicy=db.prepare('INSERT INTO commerce_policies VALUES(?,?,?,?,?,?,?) ON CONFLICT(id,version) DO UPDATE SET shop=excluded.shop,channel=excluded.channel,campaign=excluded.campaign,published=excluded.published,payload=excluded.payload')
  const saveFaq=db.prepare('INSERT INTO commerce_faq VALUES(?,?,?,?) ON CONFLICT(id,version) DO UPDATE SET published=excluded.published,payload=excluded.payload')
  const saveOrder=db.prepare('INSERT INTO commerce_orders VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET payload=excluded.payload')
  const saveProduct=db.prepare('INSERT INTO commerce_products VALUES(?,?) ON CONFLICT(sku) DO UPDATE SET payload=excluded.payload')
  const earlierFaqs=db.prepare('SELECT payload FROM commerce_faq WHERE id=? AND version<>? AND published=1')

  function writePolicy(p:ReturnPolicy) {savePolicy.run(p.id,p.version,p.shop,p.channel,p.campaign,Number(p.published),JSON.stringify(p))}
  function writeFaq(f:DemoFaq) {saveFaq.run(f.id,f.version,Number(f.published),JSON.stringify(f))}

  function list():Record<MerchantKind,MerchantRow[]> {
    return {
      products:db.prepare('SELECT payload FROM commerce_products ORDER BY sku').all().map(r=>record<MerchantRow>(r)!),
      orders:db.prepare('SELECT payload FROM commerce_orders ORDER BY id').all().flatMap(r=>orderRows(record<DemoOrder>(r)!)),
      policies:allPolicies().map(policyRow),
      faqs:db.prepare('SELECT payload FROM commerce_faq ORDER BY id,version').all().map(r=>faqRow(record<DemoFaq>(r)!)),
    }
  }

  function writeRow(kind:MerchantKind,row:MerchantRow,warn:(msg:string)=>void,entry:OrderEntry):boolean {
    if (kind==='products') {
      requireValues(row,merchantFields.products)
      const sku=identifier(row['商品编码（SKU）'],'商品编码')
      const prior=record<MerchantRow>(getProduct.get(sku))
      if (prior && equalRows(row,prior)) return false
      saveProduct.run(sku,JSON.stringify(row))
    } else if (kind==='orders') {
      if (!getProduct.get(row.成交商品编码)) throw new UnknownProductSkuError()
      const prior=record<DemoOrder>(orders.get(row.订单号.toUpperCase()))
      const next=parseOrderRow(row,prior)
      if (prior && JSON.stringify(orderRows(prior))===JSON.stringify(orderRows(next))) return false
      saveOrder.run(next.owner,next.id,JSON.stringify(next))
      const kind = prior ? 'order.updated' : entry.source==='checkout' ? 'order.placed' : entry.source==='excel' ? 'order.imported' : 'order.recorded'
      appendTrace(db,{kind,order:{shop:next.shop,owner:next.owner,orderId:next.id},
        ...(entry.source==='checkout' && {conversationId:entry.conversationId}),
        details:{source:entry.source,line:Number(row.行号),quantity:Number(row.购买数量),sku:row.成交商品编码,orderedAt:next.boughtAt}})
    } else if (kind==='policies') {
      const next=parsePolicy(row)
      const prior=record<ReturnPolicy>(getPolicy.get(next.id,next.version))
      if (prior && equalRows(policyRow(prior),policyRow(next),'发布状态')) return false
      if (prior?.published) throw Error('已发布政策只读。如需调整，请另建版本并试算。')
      if (row.发布状态==='已发布') warn('新政策已按草稿处理，试算后可发布。')
      writePolicy(next)
    } else {
      const next=parseFaq(row)
      const prior=record<DemoFaq>(getFaq.get(next.id,next.version))
      if (prior && equalRows(faqRow(prior),faqRow(next))) return false
      if (prior && isWorkbookExample(next,prior)) {
        warn('模板示例与内置问答同号同版，已沿用原已审核答复。如要更改请新增版本。')
        return false
      }
      if (prior?.published || prior?.retired) throw Error('已审核或已归档问答只读，如需修改请使用新版本。')
      if (next.retired) throw Error('新问答请填写草稿或已审核。')
      if (next.published) {
        for (const r of earlierFaqs.all(next.id,next.version)) writeFaq({...record<DemoFaq>(r)!,published:false,retired:true})
      }
      writeFaq(next)
    }
    return true
  }

  function apply(rows:MerchantRows,commit:boolean,feedbackCaseId?:string,entry:OrderEntry={source:'manual'}) {
    const errors:string[]=[], warnings:string[]=[]
    const importIssues:MerchantImportIssue[]=[]
    let changes=0
    const approvals = new Map<string,number[]>()
    for (const [index,row] of (rows.faqs ?? []).entries()) {
      if (row?.状态?.trim()!=='已审核') continue
      const id=row.问答编号?.trim()
      if (!id) continue
      const numbers=approvals.get(id) ?? []
      numbers.push(merchantRowNumber(row) ?? index+1)
      approvals.set(id,numbers)
    }
    for (const [id,numbers] of approvals) {
      if (numbers.length>1) errors.push('常见问答'+numbers.map(n=>'第 '+n+' 行').join('、')+'：问答 '+id+' 只能指定一个已审核版本。')
    }
    if (errors.length) return {ok:false,errors,warnings,importIssues,changes:0}
    const finish=beginWrite()
    try {
      for (const kind of merchantKinds) {
        const seen=new Set<string>()
        for (const [index,input] of (rows[kind] ?? []).entries()) {
          const excelRow=merchantRowNumber(input)
          const prefix=merchantSheetNames[kind]+'第 '+(excelRow ?? index+1)+' 行：'
          try {
            const row=cleanRow(kind,input)
            if (kind==='policies') guardTarget(kind,row.条款编号,row.版本,feedbackCaseId)
            if (kind==='faqs') guardTarget(kind,row.问答编号,row.版本,feedbackCaseId)
            const key=merchantRowKey(kind,row)
            if (seen.has(key)) throw Error('同批次含有重复的记录编号或订单行号。')
            seen.add(key)
            if (writeRow(kind,row,msg=>warnings.push(prefix+msg),entry)) changes++
          } catch (e) {
            if (e instanceof UnknownProductSkuError && excelRow !== undefined) {
              importIssues.push({code:'unknown_product_sku',sheet:merchantSheetNames.orders,row:excelRow})
            }
            errors.push(prefix+(e instanceof Error ? e.message : '资料校验失败。'))
          }
        }
      }
      const ok=errors.length===0
      finish(commit && ok)
      return {ok,errors,warnings,importIssues,changes:ok?changes:0}
    } catch (e) {finish(false); throw e}
  }

  function draftFor(key:string) {
    const [id,version]=key.split('@')
    const draft=record<ReturnPolicy>(getPolicy.get(id ?? '',version ?? ''))
    if (!draft || draft.published) throw Error('请选择一个尚未发布的草稿版本。')
    return draft
  }
  function trial(policyKey:string,orderIds:string[],candidate?:ReturnPolicy) {
    const draft=candidate ?? draftFor(policyKey)
    if (orderIds.length!==2 || new Set(orderIds).size!==2) throw Error('请选择两笔不同的试算订单。')
    const cases=orderIds.map(id=>{
      const order=record<DemoOrder>(orders.get(id))
      const campaigns=order?.lines?.map(line=>line.campaign) ?? [order?.campaign]
      if (!order || order.shop!==draft.shop || order.channel!==draft.channel || !campaigns.includes(draft.campaign)) {
        throw Error('试算订单须属于草稿的适用店铺、渠道与活动，请重新选择。')
      }
      return order
    })
    if (cases[0].boughtAt===cases[1].boughtAt) throw Error('请选下单时间不同的两笔订单。')
    const before=allPolicies().filter(p=>p.published && p.shop===draft.shop && p.channel===draft.channel)
    const scoped=before.filter(p=>sameScope(p,draft))
    const hasOlder=scoped.some(p=>p.id===draft.id && p.start < draft.start)
    if (hasOlder && !cases.some(o=>o.boughtAt<draft.start)) throw Error('请选择一笔草稿生效前的旧订单，与新订单对照。')
    const proposed={...draft,published:true}
    const after=[...before,proposed]
    const hits=cases.map(o=>matchPolicies(o,after))
    if (!hits.some(group=>group.some(p=>p.id===draft.id && p.version===draft.version))) throw Error('请至少选择一笔实际命中本草稿的新订单。')
    const results=replayPolicyChange(cases,before,after,DEMO_NOW)
    // Detect conflicts across the whole activation window, including scopes the two examples may miss.
    const cutovers = new Set([draft.start,...scoped.flatMap(p=>p.end===null ? [p.start] : [p.start,p.end])])
    const probe = {...cases[0],campaign:draft.campaign,lines:undefined}
    const firstOverlap=new Map<ReturnPolicy,PolicyConflict>()
    for (const time of [...cutovers].sort((a,b)=>a-b)) {
      if (time<draft.start || (draft.end!==null && time>=draft.end)) continue
      const active=matchPolicies({...probe,boughtAt:time},after)
      if (!active.includes(proposed)) continue
      for (const other of active) {
        if (other===proposed || firstOverlap.has(other)) continue
        firstOverlap.set(other,{
          draft:{id:draft.id,version:draft.version}, published:{id:other.id,version:other.version},
          reason:other.id===draft.id?'same_clause_start':'equal_priority_overlap', at:storeTime(time),
        })
      }
    }
    const conflicts=[...firstOverlap.values()]
    const issues=conflicts.map(describePolicyConflict)
    const token=createHmac('sha256',secret).update(JSON.stringify([draft,cases,before,results])).digest('hex')
    return {token,results,asOf:storeTime(DEMO_NOW),issues,conflicts}
  }

  function publish(policyKey:string,orderIds:string[],token:string,feedbackCaseId?:string) {
    const finish=beginWrite()
    try {
      const [id,version]=policyKey.split('@')
      guardTarget('policies',id,version,feedbackCaseId)
      const receipt=db.prepare('SELECT token,result FROM merchant_publications WHERE id=? AND version=?').get(id ?? '',version ?? '')
      if (receipt?.token===token && typeof receipt.result==='string') {
        const saved=JSON.parse(receipt.result) as ReturnType<typeof trial>
        if (JSON.stringify(saved.results.map(r=>r.orderId))!==JSON.stringify(orderIds)) throw Error('试算订单已改变，请重新试算。')
        finish(true)
        return {...saved,conflicts:saved.conflicts ?? []}
      }
      const current=trial(policyKey,orderIds)
      if (!token || current.token!==token) throw Error('试算凭据已过期或资料已变化，请重新试算并核对。')
      if (current.conflicts.length) throw new PolicyConflictError(current.conflicts)
      writePolicy({...draftFor(policyKey),published:true})
      db.prepare('INSERT INTO merchant_publications VALUES(?,?,?,?)').run(id,version,token,JSON.stringify(current))
      finish(true)
      return current
    } catch (e) {finish(false); throw e}
  }
  function publicationKeys() {
    return db.prepare('SELECT id,version FROM merchant_publications ORDER BY id,version').all().map(r=>r.id+'@'+r.version)
  }
  function publication(policyKey:string) {
    const [id,version]=policyKey.split('@')
    const saved=db.prepare('SELECT result FROM merchant_publications WHERE id=? AND version=?').get(id ?? '',version ?? '')
    if (!saved) return null
    const {asOf,results,issues}=JSON.parse(saved.result as string) as ReturnType<typeof trial>
    return {asOf,results,issues}
  }
  return {list,apply,trial,publish,publicationKeys,publication}
}
