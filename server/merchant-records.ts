import type { MerchantKind, MerchantRow } from '../shared/merchant.ts'
import { merchantFields } from '../shared/merchant.ts'
import { normalizeQuestion } from './commerce.ts'
import type { DemoFaq, DemoOrder, ReturnPolicy, SoldLine } from './commerce-fixtures.ts'
import { storeTime } from './commerce-rules.ts'

export function cleanRow(kind:MerchantKind, input:MerchantRow): MerchantRow {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('请提交一行表格资料。')
  const row:MerchantRow = {}
  for (const key of merchantFields[kind]) {
    const raw = input[key] ?? ''
    if (typeof raw !== 'string' || raw.length > 8000) throw Error(key + ' 必须为不超过 8000 字的文本。')
    row[key] = raw.trim()
  }
  return row
}

export function requireValues(row:MerchantRow, fields:string[]) {
  for (const field of fields) if (!row[field]) throw Error('请填写「' + field + '」。')
}

export function identifier(value:string, label:string) {
  if (!value || value.length > 64 || /[@\s\p{Cc}]/u.test(value)) throw Error(label + ' 需为 1 至 64 字，不含空白、@ 或控制字符。')
  return value
}

export function positive(value:string, label:string, max:number) {
  const n=Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1 || n > max) throw Error(label + ' 需为 1 至 ' + max + ' 的整数。')
  return n
}

function time(value:string, label:string) {
  const matched = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?$/.exec(value)
  if (matched) {
    const canonical = matched[1] + ' ' + (matched[2] ?? '00:00') + ':' + (matched[3] ?? '00')
    const ms = Date.parse(canonical.replace(' ','T') + '+08:00')
    if (Number.isFinite(ms) && storeTime(ms) === canonical) return ms
  }
  throw Error(label + ' 需填写有效的北京时间，如 2026-11-16 15:28:00。')
}

export function policyRow(rule:ReturnPolicy):MerchantRow {
  return {条款编号:rule.id, 版本:rule.version, 名称:rule.title, 适用店铺:rule.shop, 渠道:rule.channel, 活动:rule.campaign,
    '生效时间（含）':storeTime(rule.start), '失效时间（不含）':rule.end===null?'':storeTime(rule.end), 按何时选版本:'下单时间',
    期限起算点:'签收次日算第 1 天', 天数:String(rule.days), 计时口径:'日历日／北京时间／含截止日', 发布状态:rule.published?'已发布':'草稿', 条款原文:rule.text}
}

export function parsePolicy(row:MerchantRow):ReturnPolicy {
  requireValues(row,merchantFields.policies.filter(key=>!['失效时间（不含）','发布状态'].includes(key)))
  if (!['','草稿','示例草稿','已发布','待发布'].includes(row.发布状态)) throw Error('发布状态请填草稿或已发布。导入的新政策一律保存为草稿。')
  if (row.按何时选版本!=='下单时间' || row.期限起算点.replaceAll(' ','')!=='签收次日算第1天' ||
      row.计时口径.replaceAll('/','／').replaceAll(' ','')!=='日历日／北京时间／含截止日') {
    throw Error('支持按下单时间选版，签收次日算第 1 天，按北京时间的日历日计算并含截止日。')
  }
  const start=time(row['生效时间（含）'],'生效时间')
  const end=row['失效时间（不含）']?time(row['失效时间（不含）'],'失效时间'):null
  if (end!==null && end<=start) throw Error('失效时间必须晚于生效时间。')
  const days=positive(row.天数,'天数',3650)
  const canonical=`本条适用于${row.适用店铺}在${row.渠道}售出的${row.活动}商品。按下单时间选用规则版本。从签收次日起计第 1 天，共 ${days} 个日历日。可在最后一天北京时间 23:59:59 前（含该秒）提出退货申请。`
  const compact = (s:string) => s.replace(/\s/gu,'').replace(/。$/u,'')
  const reviewText=![canonical,`签收次日起${days}个日历日内可申请退货。`].some(standard=>compact(standard)===compact(row.条款原文))
  return {id:identifier(row.条款编号,'条款编号'),version:identifier(row.版本,'版本'),shop:row.适用店铺,channel:row.渠道,campaign:row.活动,
    title:row.名称,text:row.条款原文,days,start,end,priority:10,published:false,...(reviewText?{reviewText:true}:{})}
}

export function faqRow(faq:DemoFaq):MerchantRow {
  return {问答编号:faq.id,版本:faq.version,顾客常用问法:faq.title,其他常见问法:faq.aliasText ?? faq.aliases.join('／'),
    标准答复:faq.text,依据或来源:faq.reference ?? '演示店铺办理说明',状态:faq.published?'已审核':faq.retired?'已归档':'草稿'}
}

export function parseFaq(row:MerchantRow):DemoFaq {
  requireValues(row,['问答编号','版本','顾客常用问法','标准答复','依据或来源'])
  if (!['已审核','草稿','示例草稿','待审核','已归档',''].includes(row.状态)) throw Error('问答状态应为草稿或已审核。')
  const aliases = [...new Set([row.顾客常用问法,...row.其他常见问法.split(/[／/|；;\n]/u)].map(normalizeQuestion).filter(Boolean))]
  if (!aliases.length) throw Error('请提供至少一个有效的顾客问法。')
  return {id:identifier(row.问答编号,'问答编号'),version:identifier(row.版本,'问答版本'),title:row.顾客常用问法,
    text:row.标准答复,reference:row.依据或来源,aliases,aliasText:row.其他常见问法,published:row.状态==='已审核',...(row.状态==='已归档'?{retired:true}:{})}
}

export function orderRows(order:DemoOrder):MerchantRow[] {
  const lines=order.lines ?? [{line:1,sku:'',description:order.product,quantity:1,campaign:order.campaign,shipping:order.shipping,signedAt:order.signedAt,updatedAt:order.updatedAt}]
  return lines.map(line=>({订单号:order.id,行号:String(line.line),店铺会员编号:order.owner,成交商品编码:line.sku,成交商品与规格:line.description,
    购买数量:String(line.quantity),店铺:order.shop,成交渠道:order.channel,成交活动:line.campaign,下单时间:storeTime(order.boughtAt),物流状态:line.shipping,
    签收时间:line.signedAt===null?'':storeTime(line.signedAt),物流更新时间:storeTime(line.updatedAt)}))
}

export function parseOrderRow(row:MerchantRow, previous:DemoOrder|undefined):DemoOrder {
  requireValues(row,merchantFields.orders.filter(key=>key!=='签收时间'))
  const owner=row.店铺会员编号.toUpperCase()
  if (owner !== 'A' && owner !== 'B') throw Error('演示店铺会员编号仅支持 A 或 B。')
  const id=identifier(row.订单号.toUpperCase(),'订单号')
  const boughtAt=time(row.下单时间,'下单时间')
  const signedAt=row.签收时间?time(row.签收时间,'签收时间'):null
  const updatedAt=time(row.物流更新时间,'物流更新时间')
  if (updatedAt<boughtAt || (signedAt!==null && (signedAt<boughtAt || signedAt>updatedAt))) throw Error('请核对订单时间顺序：下单、签收、物流更新。')
  if (row.物流状态==='已签收' && signedAt===null) throw Error('物流状态为已签收时必须提供签收时间。')
  if (signedAt!==null && ['未发货','待发货','运输中','配送中','待签收'].includes(row.物流状态)) throw Error('物流状态与签收时间不一致。')
  const line:SoldLine={line:positive(row.行号,'行号',99999),sku:identifier(row.成交商品编码,'成交商品编码'),
    description:row.成交商品与规格,quantity:positive(row.购买数量,'购买数量',999999),campaign:row.成交活动,shipping:row.物流状态,signedAt,updatedAt}
  if (previous && (previous.owner!==owner || previous.shop!==row.店铺 || previous.channel!==row.成交渠道 ||
    storeTime(previous.boughtAt)!==storeTime(boughtAt))) throw Error('此订单的会员、店铺、渠道或下单时间与原成交记录不一致。')
  const existing = previous?.lines?.find(item=>item.line===line.line)
  if (existing) {
    if (existing.sku!==line.sku || existing.quantity!==line.quantity || existing.description!==line.description || existing.campaign!==line.campaign) throw Error('已保存的订单行不可更换成交商品、规格、数量或活动。')
    if (updatedAt<existing.updatedAt || (existing.signedAt!==null && existing.signedAt!==signedAt)) throw Error('物流更新不能倒退或覆盖已核实的签收时间。')
    if (updatedAt===existing.updatedAt && (existing.shipping!==line.shipping || existing.signedAt!==line.signedAt)) throw Error('相同时间的物流更新与已有记录冲突。')
  } else if (previous && !previous.lines &&
    (line.line!==1 || !(line.description===previous.product || line.description.startsWith(previous.product+' · ')) || line.campaign!==previous.campaign ||
     line.shipping!==previous.shipping || line.signedAt!==previous.signedAt || line.updatedAt!==previous.updatedAt)) {
    throw Error('补录历史订单须先填写与原商品、活动和物流一致的第 1 行。')
  }
  const lines=[...(previous?.lines ?? []).filter(item=>item.line!==line.line),line].sort((a,b)=>a.line-b.line)
  const distinct=<T,>(get:(line:SoldLine)=>T)=> [...new Set(lines.map(get))]
  const receipts=distinct(item=>item.signedAt)
  return {...previous,id,owner,shop:row.店铺,channel:row.成交渠道,campaign:distinct(item=>item.campaign).join('、'),
    boughtAt:previous?.boughtAt ?? boughtAt, product:lines.map(item=>item.description).join('、'),
    shipping:distinct(item=>item.shipping).join('、'),updatedAt:Math.max(...lines.map(item=>item.updatedAt)),signedAt:receipts.length===1?receipts[0]:null,lines}
}
