import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import type { CommerceCard, CommerceQuery, CommerceResult, CommerceState, CommerceTrace, DemoAccount, PolicySource } from '../shared/commerce.ts'
import { DEMO_NOW, demoFaqs, demoOrders, demoPolicies, type DemoFaq, type DemoOrder, type ReturnPolicy } from './commerce-fixtures.ts'
import { evaluateReturn, matchPolicies, matchFaqs, normalizeQuestion, storeTime } from './commerce-rules.ts'
import type { TraceDetails, TraceOrderRef } from '../shared/trace.ts'
import { appendTrace, initTraceStore } from './trace-store.ts'
export {normalizeQuestion} from './commerce-rules.ts'

export type OrderReader = (account: DemoAccount, orderId: string, signal: AbortSignal) => Promise<DemoOrder | null>
interface CommerceOptions {
  now?: () => number
  orderTimeoutMs?: number
  orderReader?: OrderReader
  onTrace?: (conversationId: string, trace: CommerceTrace) => void
}

function orderReferences(input:string, ownIds:string[]) {
  const references = new Set<string>()
  // Match exact identifiers from this customer's account, even Chinese, short or dotted ones.
  const identifierChar = (char:string|undefined) => !!char && /[A-Z0-9._-]/u.test(char)
  for (const id of ownIds) {
    let index=input.indexOf(id)
    while (index>=0) {
      const preceding=input.slice(0,index)
      const joinedChinese=/\p{Script=Han}$/u.test(preceding) && /^\p{Script=Han}/u.test(id)
      const startsHere=!joinedChinese || /(?:查一下|查查|帮我查|查询|查|订单(?:号码?|编号)?|单号|是|为)$/u.test(preceding)
      if (startsHere && !identifierChar(input[index-1]) && !identifierChar(input[index+id.length])) {references.add(id);break}
      index=input.indexOf(id,index+id.length)
    }
  }
  const marker=/(订单编号|订单号码?|单号|订单(?=[\s：:#])|查一下|查查|帮我查|查询)[\s：:#]*(?:是|为)?/gu
  let mentionsNumber=false
  for (const match of input.matchAll(marker)) {
    const following=input.slice(match.index+match[0].length).trimStart()
    if ([...references].some(id=>following.startsWith(id) && !identifierChar(following[id.length]))) continue
    const raw=/^[\p{L}\d_.-]+/u.exec(following)?.[0] ?? ''
    const id=raw.replace(/(?:的(?:物流|快递|订单)|(?:还能|能不能|能否|可以|能)退|怎么|在哪|到哪).*$/u,'')
    if (['查一下','查查','帮我查','查询'].includes(match[1]) && (!/[\d_.-]/u.test(id) || /^订单|^单号/u.test(id))) continue
    mentionsNumber=true
    if (id) references.add(id)
  }
  for (const match of input.matchAll(/(?<![A-Z\d._-])([A-Z\d]+(?:[-_.][A-Z\d]+)+|[A-Z]+\d+|\d{5,})(?![A-Z\d._-])/gu)) {
    references.add(match[1])
  }
  return {references,mentionsNumber}
}

export function parseCommerceQuery(text: string, selectedOrderId?: string, ownIds:string[] = [], approvedFaq?:boolean): CommerceQuery | null {
  const question = text.trim()
  const normalized = normalizeQuestion(question)
  const input = question.toUpperCase().replaceAll('－', '-')
  const {references,mentionsNumber}=orderReferences(input,ownIds)
  const [explicit] = references
  const multiple = references.size > 1 || /(?:这|那|另)?(?:两|几|多)[笔单]|(?:这|那)些订单/u.test(question)
  const rowRefs = [...question.matchAll(/第\s*([\d一二三四五六七八九十百两]+)\s*行/gu)]
  if (rowRefs.length && /退/u.test(question)) {
    const id = multiple ? '' : explicit || (/这单|这笔|该单|此单/u.test(question) ? selectedOrderId : '') || ''
    const amounts = [...question.matchAll(/(?:想退|要退|只退|退|申请数量为?)\s*(\d+)\s*[件个套]/gu)]
    const line = Number(rowRefs[0][1])
    if (rowRefs.length === 1 && amounts.length === 1 && Number.isSafeInteger(line) && line > 0) {
      return {kind:'return',orderId:id,line,quantity:Number(amounts[0][1])}
    }
    return {kind:'return',orderId:id,partial:true}
  }
  const partial = /(?:只退|想退|要退|退其中|退掉|申请退|退回?)(?:其中(?:的)?|部分(?:的)?|一部分|[一二两三四五六七八九十\d]+[件个套])|部分退(?:货|款)/u.test(question)
  const orderId = multiple || (!explicit && (partial || mentionsNumber)) ? '' : explicit || selectedOrderId || ''
  const orderContext=mentionsNumber || multiple || partial || /(?:这|那|上一|刚才那|本)(?:笔|单)|(?:我(?:的)?|这个|那个|本人)订单/u.test(question) ||
    (!!explicit && /退|查单|订单|查一下|物流|快递|发货|到哪/u.test(question))
  const faq=approvedFaq ?? demoFaqs.some(f=>f.published && f.aliases.includes(normalized))
  if (faq && !orderContext) return { kind:'faq', question }
  if (partial) return { kind:'return', orderId, partial:true }
  if (/退货|退款|能退|能不能退|可以退|还能退|能否退|可退|想退|要退|退不了|退不退|退吗|退换|退掉|退一下/u.test(question)) {
    const asksForOrder = /这[个笔单件]|我[的要想买]|本[笔单]|订单|单号|能退|能不能退|可以退|还能退|能否退|可退|退吗|退不了|退不退/u.test(question)
    if (!explicit && !asksForOrder && !(selectedOrderId && /想退|要退/u.test(question))) return { kind:'faq', question }
    return { kind:'return', orderId }
  }
  const asksForShipping = /查单|订单|物流|快递|发货|签收|配送|到哪|运单/u.test(question)
  const looksUpReference = explicit && ((input===explicit && (ownIds.includes(explicit) || /\d/u.test(explicit))) || /查一下|查查|帮我查|查询|这笔|这单/u.test(question))
  if (asksForShipping || looksUpReference) return { kind:'order', orderId }
  if (/售后|政策|保修|运费|邮费|补寄|补发|赔付|补贴/u.test(question)) return { kind:'faq', question }
  return null
}

const testPins: Record<DemoAccount,string> = { A:'1111', B:'2222' }

function source(record: PolicySource): PolicySource {
  return { id:record.id, version:record.version, title:record.title, text:record.text }
}

export function orderFacts(order: DemoOrder, product: (sku:string) => Record<string,string> | undefined): CommerceCard['facts'] {
  return [
    { label:'订单号', value:order.id }, { label:'商品', value:order.product },
    { label:'店铺 / 渠道', value:order.shop + ' / ' + order.channel },
    { label:'活动', value:order.campaign }, { label:'下单时间', value:storeTime(order.boughtAt) },
    { label:'物流状态', value:order.shipping }, { label:'物流更新时间', value:storeTime(order.updatedAt) },
    { label:'签收时间', value:order.signedAt === null ? '请查看明细或待补充签收记录' : storeTime(order.signedAt) },
    ...(order.lines ?? []).flatMap(line => {
      const record = product(line.sku)
      const facts = [{label:`成交明细 · 第 ${line.line} 行`, value:`${line.description} × ${line.quantity} · ${line.sku} · ${line.campaign} · ${line.shipping} · ${line.signedAt === null ? '尚无签收记录' : storeTime(line.signedAt) + ' 签收'}`}]
      if (record) facts.push({label:'当前商品资料 · ' + line.sku, value:record['已确认的商品事实'] + '（来源：' + record['事实来源'] + '）'})
      return facts
    }),
  ]
}

async function timedLookup(reader: OrderReader, account: DemoAccount, id: string, timeout: number, caller?: AbortSignal) {
  const deadline = new AbortController()
  const signal = caller ? AbortSignal.any([caller, deadline.signal]) : deadline.signal
  signal.throwIfAborted()
  const timer = setTimeout(() => deadline.abort(new DOMException('订单接口超时', 'TimeoutError')), timeout)
  let cancel: () => void = () => {}
  try {
    const stopped = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason)
      signal.addEventListener('abort', cancel, { once:true })
    })
    return await Promise.race([reader(account, id, signal), stopped])
  } catch (error) {
    caller?.throwIfAborted()
    if (deadline.signal.aborted) throw deadline.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
}

export function openCommerce(path: string | DatabaseSync, options: CommerceOptions = {}) {
  const db = typeof path === 'string' ? new DatabaseSync(path) : path
  const now = options.now ?? (() => DEMO_NOW)
  db.exec(`
    CREATE TABLE IF NOT EXISTS commerce_accounts (conversation TEXT PRIMARY KEY, account TEXT NOT NULL CHECK(account IN ('A','B'))) STRICT;
    CREATE TABLE IF NOT EXISTS commerce_cards (conversation TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS commerce_orders (owner TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner,id)) STRICT;
    CREATE TABLE IF NOT EXISTS commerce_policies (id TEXT NOT NULL, version TEXT NOT NULL, shop TEXT NOT NULL, channel TEXT NOT NULL, campaign TEXT NOT NULL, published INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id,version)) STRICT;
    CREATE TABLE IF NOT EXISTS commerce_faq (id TEXT NOT NULL, version TEXT NOT NULL, published INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id,version)) STRICT;
    CREATE TABLE IF NOT EXISTS commerce_products (sku TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS commerce_case_evidence (conversation TEXT NOT NULL, card TEXT NOT NULL, facts TEXT NOT NULL, PRIMARY KEY(conversation,card)) STRICT;
  `)
  const addOrder = db.prepare('INSERT OR IGNORE INTO commerce_orders VALUES (?, ?, ?)')
  const addRule = db.prepare('INSERT OR IGNORE INTO commerce_policies VALUES (?, ?, ?, ?, ?, ?, ?)')
  const addFaq = db.prepare('INSERT OR IGNORE INTO commerce_faq VALUES (?, ?, ?, ?)')
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const row of demoOrders) addOrder.run(row.owner, row.id, JSON.stringify(row))
    for (const row of demoPolicies) addRule.run(row.id, row.version, row.shop, row.channel, row.campaign, Number(row.published), JSON.stringify(row))
    for (const row of demoFaqs) addFaq.run(row.id, row.version, Number(row.published), JSON.stringify(row))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  const binding = db.prepare('SELECT account FROM commerce_accounts WHERE conversation=?')
  const bind = db.prepare('INSERT OR IGNORE INTO commerce_accounts VALUES (?,?)')
  const readCard = db.prepare('SELECT payload FROM commerce_cards WHERE conversation=?')
  const writeCard = db.prepare('INSERT INTO commerce_cards VALUES (?,?) ON CONFLICT(conversation) DO UPDATE SET payload=excluded.payload')
  const fetchOrder = db.prepare('SELECT payload FROM commerce_orders WHERE owner=? AND id=?')
  const list = db.prepare('SELECT payload FROM commerce_orders WHERE owner=? ORDER BY id')
  const policies = db.prepare('SELECT payload FROM commerce_policies WHERE published=1 AND shop=? AND channel=?')
  const faqs = db.prepare('SELECT payload FROM commerce_faq WHERE published=1 ORDER BY id,version')
  const fetchProduct = db.prepare('SELECT payload FROM commerce_products WHERE sku=?')
  const accountIds = db.prepare('SELECT id FROM commerce_orders WHERE owner=?')
  // The commerce module is also used on standalone merchant databases, with no customer session.
  const sessions = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='conversations'").get()
    ? db.prepare('SELECT 1 FROM conversations WHERE id=?') : null
  if (sessions) initTraceStore(db)
  function matchedFaqs(question:string) {
    return matchFaqs(question,faqs.all().map(row => JSON.parse(row.payload as string) as DemoFaq))
  }
  const evidence=new WeakMap<CommerceCard,DemoOrder>()
  const saveEvidence=db.prepare('INSERT OR IGNORE INTO commerce_case_evidence VALUES(?,?,?)')

  function trace(id: string, step: CommerceTrace['step'], outcome: CommerceTrace['outcome'], code: string, start: number, version?: string,
    context?:{order?:TraceOrderRef;details:TraceDetails}) {
    const elapsedMs=Math.max(0,Math.round(performance.now()-start))
    const kinds={identity:'identity.checked',orders:'orders.lookup',policy:'policy.lookup',eligibility:'eligibility.checked'} as const
    if (context) appendTrace(db,{kind:kinds[step],conversationId:id,order:context.order,
      status:code==='lookup_started' ? 'info' : outcome,details:{...context.details,code,elapsedMs}})
    options.onTrace?.(id, { step, outcome, code, elapsedMs, ...(version ? { version } : {}) })
  }

  function accountOf(id: string) {
    return (binding.get(id)?.account as DemoAccount | undefined) ?? null
  }

  const readOrder: OrderReader = options.orderReader ?? (async (account, id, signal) => {
    const row = fetchOrder.get(account, id)
    if (!row) return null
    const order: DemoOrder = JSON.parse(row.payload as string)
    if (order.slowLookup) await delay(60000, undefined, { signal })
    return order
  })

  async function ask(id: string, query: CommerceQuery, signal?: AbortSignal, causeMessageId?:string): Promise<CommerceResult> {
    signal?.throwIfAborted()
    const at = now()
    const linked=!!sessions?.get(id)
    let verifiedOrder:TraceOrderRef|undefined
    const details:TraceDetails={queryKind:query.kind,...(causeMessageId && {causeMessageId})}
    function step(name:CommerceTrace['step'], outcome:CommerceTrace['outcome'], code:string, start:number,
      sources:PolicySource[]=[], deadline?:string|null) {
      const versions=sources.map(s=>s.id+'@'+s.version).join('、')
      trace(id,name,outcome,code,start,sources.length===1 && code!=='line_review'?sources[0].version:undefined,
        linked ? {order:verifiedOrder,details:{...details,...(versions && {versions}),...(deadline && {deadline})}} : undefined)
    }
    const base: CommerceCard = {
      kind: query.kind, status: 'review', title: '需要人工核对', summary: '', reason: '',
      request: query.kind === 'faq' ? query.question : query.kind === 'order' ? '查询订单与物流' : '判断能否申请退货',
      sources: [], facts: [], deadline: null, asOf: storeTime(at), missing: [],
      nextStep: '坐席将核对资料后在本窗口回复。',
    }
    function answer(fields: Partial<CommerceCard>, handoff = false): CommerceResult {
      return {card: {...base, ...fields}, handoff}
    }
    if (query.kind === 'faq') {
      const start = performance.now()
      const matched = matchedFaqs(query.question)
      if (matched.length === 1) {
        const faq = matched[0]
        step('policy','ok','matched',start,matched)
        return answer({
          status: 'found', title: faq.title, summary: faq.text, sources: [source(faq)],
          facts: faq.reference ? [{label:'依据或来源',value:faq.reference}] : [],
          reason: '已匹配经审核的常见问答。', nextStep: '可选择本人订单，查看具体办理期限。',
        })
      }
      step('policy','blocked',matched.length ? 'conflict' : 'missing_policy',start,matched)
      return answer({
        summary: '需要坐席确认这项咨询的适用规则。',
        reason: matched.length ? '多个已发布条款同时匹配。' : '未命中已审核的问答条款。',
        missing: ['适用的已审核答复'], sources: matched.map(source),
      }, true)
    }
    const identityStart = performance.now()
    const account = accountOf(id)
    step('identity',account ? 'ok' : 'blocked',account ? 'verified' : 'login_required',identityStart)
    if (!account) return answer({
      status: 'login_required', title: '请先登录测试账号', summary: '登录后可以查看自己的订单和退货资格。',
      reason: '尚未核验顾客身份。', nextStep: '在本窗口选择测试账号并输入对应口令。', missing: ['顾客登录身份'],
    })
    const orderStart = performance.now()
    if (!query.orderId.trim()) {
      step('orders','blocked','not_found',orderStart)
      return answer({
        status: 'not_found', title: '请选择要查询的订单', summary: '从本人订单列表选择一笔，或在问题中提供订单号。',
        reason: '需要确认本次咨询的订单。', nextStep: '选择本人订单后重新查询。', missing: ['待查询订单'],
      })
    }
    const orderId = query.orderId.trim().toUpperCase()
    let order: DemoOrder | null
    step('orders','ok','lookup_started',orderStart)
    try {
      order = await timedLookup(readOrder, account, orderId, options.orderTimeoutMs ?? 1600, signal)
      signal?.throwIfAborted()
    } catch (error) {
      signal?.throwIfAborted()
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      step('orders','error',timedOut ? 'timeout' : 'error',orderStart)
      const reason = timedOut ? '订单接口超时，本次未取得可核验的订单事实。' : '订单接口暂时不可用，本次未取得可核验的订单事实。'
      return answer({ summary: reason, reason, missing: ['订单与物流事实'] }, true)
    }
    if (!order || order.id !== orderId || order.owner !== account) {
      step('orders','blocked','not_found',orderStart)
      return answer({
        status: 'not_found', title: '未找到本人订单', summary: '请核对订单号，或从本人订单中重新选择。',
        reason: '当前账户下未找到可读取的订单。', nextStep: '核对订单号后再试。', missing: ['可核验的本人订单'],
      })
    }
    let selectedLine: CommerceCard['selectedLine']
    verifiedOrder={shop:order.shop,owner:account,orderId:order.id}
    if (query.kind === 'return' && query.partial && query.line === undefined && order.lines?.length) {
      step('orders','blocked','select_line',orderStart)
      return answer({status:'select_line',title:'请选择要退的商品和数量',summary:'请在「我的订单」里选择这笔订单、对应商品和数量，再点「判断能否退货」。',
        reason:'本次只查询部分商品，需要明确商品行和数量。',orderId:order.id,missing:['待退商品行和数量'],nextStep:'也可以直接输入“这单第 2 行想退 1 件”，将行号、数量换成你的选择。'})
    }
    if (query.kind === 'return' && (query.line !== undefined || query.quantity !== undefined)) {
      const item = order.lines?.find(item => item.line === query.line)
      const quantity = query.quantity
      if (!item || !Number.isSafeInteger(quantity) || quantity === undefined || quantity < 1 || quantity > item.quantity) {
        step('orders','blocked','invalid_line',orderStart)
        const reason = item ? `第 ${item.line} 行购买了 ${item.quantity} 件，请重新填写退货数量。` : '这笔订单没有可核验的对应商品行。'
        return answer({status:'select_line',title:'请重新选择退货商品和数量',summary:reason,reason,
          nextStep:'从「我的订单」选择商品并填写数量后重新查询。',missing:['有效的商品行和退货数量']})
      }
      selectedLine = {line:item.line,sku:item.sku,description:item.description,quantity}
      details.line=item.line
      details.quantity=quantity
      // Persist the same line-level order facts that the online decision and historical replay use.
      order = {...order,product:item.description,campaign:item.campaign,shipping:item.shipping,
        signedAt:item.signedAt,updatedAt:item.updatedAt,lines:[item]}
    }
    step('orders','ok',selectedLine ? 'line_found' : 'found',orderStart)
    const verified = { facts: orderFacts(order, sku => {
      const row = fetchProduct.get(sku)
      return row && JSON.parse(row.payload as string)
    }), orderId: order.id }
    if (query.kind === 'order') return answer({
      ...verified, status: 'found', title: '订单与物流',
      summary: `${order.product} · ${order.shipping}。物流更新时间为 ${storeTime(order.updatedAt)}。`,
      reason: '已根据本次登录身份核验订单归属。', nextStep: '可以继续查询这笔订单能否申请退货。',
    })
    const policyStart = performance.now()
    const scoped = policies.all(order.shop, order.channel).map(row => JSON.parse(row.payload as string) as ReturnPolicy)
    const matched = matchPolicies(order, scoped)
    const mixedCampaigns = order.lines && new Set(order.lines.map(line=>line.campaign)).size > 1
    const version = !mixedCampaigns && matched.length === 1 ? matched[0].version : undefined
    const policyCode = mixedCampaigns ? 'line_review' : version ? 'matched' : matched.length ? 'conflict' : 'missing_policy'
    step('policy',version ? 'ok' : 'blocked',policyCode,policyStart,matched)
    const ruleStart = performance.now()
    const decision = evaluateReturn(order, matched, at,query.partial)
    step('eligibility',decision.status==='review' ? 'blocked' : 'ok',decision.code,ruleStart,matched,decision.deadline)
    const { status, reason, missing, deadline } = decision
    const title = { eligible:'可申请退货', expired:'已过退货申请期限', review:'退货资格待人工核对' }[status]
    const nextStep = {
      eligible: '如需办理，请转人工，坐席将根据这张卡协助处理。',
      expired: '如有特殊情况，请转人工说明，坐席可以复核本次依据。',
      review: base.nextStep,
    }[status]
    const result=answer({
      ...verified, status, title, summary: reason, reason, missing, deadline, nextStep, sources: matched.map(source),
      ...(selectedLine ? {selectedLine,request:`核对第 ${selectedLine.line} 行「${selectedLine.description}」${selectedLine.quantity} 件的退货资格`} : {}),
    }, status === 'review')
    evidence.set(result.card,order)
    return result
  }

  return {
    login(id: string, account: string, pin: string) {
      const start = performance.now()
      const context=sessions?.get(id) ? {details:{source:'login'}} : undefined
      if ((account !== 'A' && account !== 'B') || pin !== testPins[account]) {
        trace(id,'identity','blocked','invalid_login',start,undefined,context)
        return false
      }
      bind.run(id,account)
      const accepted = accountOf(id) === account
      trace(id,'identity',accepted ? 'ok' : 'blocked',accepted ? 'verified' : 'account_locked',start,undefined,context)
      return accepted
    },
    state(id: string, includeOrders = true): CommerceState {
      const account = accountOf(id)
      const card = readCard.get(id)
      const orders = account && includeOrders ? list.all(account).map(row => {
        const order: DemoOrder = JSON.parse(row.payload as string)
        return { id:order.id, label:`${order.product} · ${storeTime(order.boughtAt).slice(5,10)} 下单 · ${order.shipping}`,
          lines:order.lines?.map(({line,description,quantity}) => ({line,description,quantity})) }
      }) : []
      return { account, orders, latestCard:card ? JSON.parse(card.payload as string) : null, asOf:storeTime(now()) }
    },
    ask,
    parseQuery(question:string, orderId?:string, conversationId?:string, approvedFaq?:boolean): CommerceQuery | null {
      const account = conversationId ? accountOf(conversationId) : null
      const ownIds=account ? accountIds.all(account).map(r=>r.id as string) : []
      const query = parseCommerceQuery(question,orderId,ownIds,approvedFaq ?? matchedFaqs(question).length>0)
      if (account && conversationId && query?.kind === 'return' && query.orderId === orderId &&
        /^(?:那)?(?:刚才选的|刚才那|这|那)(?:一)?件(?:商品)?(?:现在)?(?:还能|能不能|可不可以|可以|能否|能)退(?:货)?(?:吗|么)?$/u.test(normalizeQuestion(question))) {
        const saved = readCard.get(conversationId)
        const last: CommerceCard | undefined = saved && JSON.parse(String(saved.payload))
        if (last?.selectedLine && last.orderId === orderId) {
          return {...query,line:last.selectedLine.line,quantity:last.selectedLine.quantity}
        }
      }
      return query
    },
    saveCard(id: string, card: CommerceCard) {
      const json=JSON.stringify(card)
      writeCard.run(id,json)
      const order=evidence.get(card)
      if (order) saveEvidence.run(id,json,JSON.stringify(order))
    },
    close() { if (typeof path === 'string') db.close() },
  }
}

export type Commerce = ReturnType<typeof openCommerce>
