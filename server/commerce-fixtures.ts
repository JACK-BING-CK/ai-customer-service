import type { DemoAccount, PolicySource } from '../shared/commerce.ts'

export const DEMO_NOW = Date.parse('2026-11-24T00:00:00+08:00')

export interface SoldLine {
  line: number
  sku: string
  description: string
  quantity: number
  campaign: string
  shipping: string
  signedAt: number | null
  updatedAt: number
}

export interface DemoOrder {
  id: string
  owner: DemoAccount
  shop: string
  channel: string
  campaign: string
  product: string
  boughtAt: number
  signedAt: number | null
  shipping: string
  updatedAt: number
  slowLookup?: boolean
  lines?: SoldLine[]
}

export interface ReturnPolicy extends PolicySource {
  shop: string
  channel: string
  campaign: string
  start: number
  end: number | null
  published: boolean
  days: number
  priority: number
  reviewText?: boolean
}

const shop = '山溪测试店'
const channel = '店铺网页'
const campaign = '秋季活动'
const cutover = Date.parse('2026-11-15T00:00:00+08:00')
const beginning = Date.parse('2026-01-01T00:00:00+08:00')
const receipt = Date.parse('2026-11-16T15:28:00+08:00')

const standardOrder: DemoOrder = {
  id: 'DEMO-1001', owner: 'A', shop, channel, campaign, product: '山溪旅行杯',
  boughtAt: cutover - 1, signedAt: receipt, shipping: '已签收', updatedAt: receipt,
}
export const demoOrders: DemoOrder[] = [
  standardOrder,
  { ...standardOrder, id: 'DEMO-1002', boughtAt: cutover },
  { ...standardOrder, id: 'DEMO-1003', boughtAt: cutover, signedAt: null, shipping: '运输中', updatedAt: receipt + 86400000 },
  { ...standardOrder, id: 'DEMO-1004', product: '接口超时演练单', slowLookup: true },
  { ...standardOrder, id: 'DEMO-1005', campaign: '联名预售', product: '联名纪念杯' },
  { ...standardOrder, id: 'DEMO-2001', owner: 'B', product: '山溪随行壶', boughtAt: cutover },
]

function policy(version: string, days: number, start: number, end: number | null, scope = campaign): ReturnPolicy {
  return {
    id: scope === campaign ? 'RET-ACT-01' : 'RET-CO-01', version, title: scope + '商品退货时限',
    shop, channel, campaign: scope, start, end, published: true, days, priority: 10,
    text: `本条适用于${shop}在${channel}售出的${scope}商品。按下单时间选用规则版本。从签收次日起计第 1 天，共 ${days} 个日历日。可在最后一天北京时间 23:59:59 前（含该秒）提出退货申请。`,
  }
}

export const demoPolicies: ReturnPolicy[] = [
  policy('V1', 7, beginning, cutover),
  policy('V2', 14, cutover, null),
  policy('CO1', 7, beginning, null, '联名预售'),
  policy('CO2', 14, beginning, null, '联名预售'),
  { ...policy('V3', 30, cutover, null), published: false },
]

export interface DemoFaq extends PolicySource { aliases: string[]; published: boolean; reference?: string; retired?: boolean; aliasText?: string }
export const demoFaqs: DemoFaq[] = [
  {
    id: 'FAQ-RET-01', version: 'F1', title: '怎样发起退货申请',
    text: '在顾客窗口选择本人订单，查看退货资格与适用条款。有办理意向时可以转人工，坐席将核对判断依据并说明下一步。',
    aliases: ['退货怎么申请', '怎么申请退货', '怎样办理退货', '如何办理退货', '如何退货', '退货流程是什么', '退货流程'], published: true,
  },
  {
    id: 'FAQ-RET-02', version: 'F1', title: '退货期限如何起算',
    text: '秋季活动商品依据下单时间选用退货政策。签收次日为第 1 天，按日历日计算，截止当日按北京时间处理。选择本人订单可查看准确版本和截止日。',
    aliases: ['退货期限怎么算', '退货从哪天开始算', '退货时间怎么算', '退货期限怎么计算', '退货时限怎么计算'], published: true,
  },
]
