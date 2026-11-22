export const merchantKinds = ["products", "orders", "policies", "faqs"] as const;
export type MerchantKind = typeof merchantKinds[number];
export type MerchantRow = Record<string, string>;
export type MerchantRows = Partial<Record<MerchantKind, MerchantRow[]>>;

export interface Decision { status: string; version: string; deadline: string | null; reason: string }
export interface TrialReport {
  asOf: string; issues: string[];
  results: { orderId: string; before: Decision; after: Decision; changed: boolean; reason: string }[];
}

export interface PolicyConflict {
  draft: { id: string; version: string };
  published: { id: string; version: string };
  reason: 'same_clause_start' | 'equal_priority_overlap';
  at: string;
}

export function describePolicyConflict(conflict: PolicyConflict): string {
  const { draft, published, at, reason } = conflict;
  const cause = reason === 'same_clause_start'
    ? '条款编号和生效时刻相同，两个版本同时适用'
    : '两条政策的有效期重叠且优先级相同';
  return `草稿 ${draft.id} ${draft.version} 与已发布的 ${published.id} ${published.version} 适用于相同的店铺、渠道和活动。${cause}。北京时间 ${at} 无法选出唯一版本，已拦住发布。`;
}
export const merchantKeyFields: Record<MerchantKind, string[]> = {
  products:["商品编码（SKU）"], orders:["订单号","行号"], policies:["条款编号","版本"], faqs:["问答编号","版本"],
};
export function merchantRowKey(kind: MerchantKind, row: MerchantRow): string {
  return JSON.stringify(merchantKeyFields[kind].map(key => {
    const value = (row[key] ?? "").trim();
    if (kind === "orders" && key === "订单号") return value.toUpperCase();
    if (kind === "orders" && key === "行号" && /^\d+$/.test(value)) return value.replace(/^0+(?=\d)/, "");
    return value;
  }));
}

export const merchantSheetNames = {
  products: "商品资料", orders: "已售明细", policies: "政策版本", faqs: "常见问答",
} as const satisfies Record<MerchantKind, string>;

export interface MerchantImportIssue {
  code: "unknown_product_sku";
  sheet: typeof merchantSheetNames.orders;
  row: number;
}

export const merchantFields: Record<MerchantKind, string[]> = {
  products: ["商品编码（SKU）", "商品名称", "规格或型号", "商品类别", "已确认的商品事实", "事实来源"],
  orders: ["订单号", "行号", "店铺会员编号", "成交商品编码", "成交商品与规格", "购买数量", "店铺", "成交渠道", "成交活动", "下单时间", "物流状态", "签收时间", "物流更新时间"],
  policies: ["条款编号", "版本", "名称", "适用店铺", "渠道", "活动", "生效时间（含）", "失效时间（不含）", "按何时选版本", "期限起算点", "天数", "计时口径", "发布状态", "条款原文"],
  faqs: ["问答编号", "版本", "顾客常用问法", "其他常见问法", "标准答复", "依据或来源", "状态"],
};

// Keep worksheet provenance out of the data saved and sent to the client.
const importRowNumbers = new WeakMap<MerchantRow, number>();
export function rememberMerchantRowNumber(row: MerchantRow, number: number) {
  importRowNumbers.set(row, number);
}
export function merchantRowNumber(row: MerchantRow) {
  return importRowNumbers.get(row);
}
