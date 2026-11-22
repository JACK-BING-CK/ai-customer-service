import type { MerchantKind, MerchantRow, TrialReport } from "../shared/merchant";
import { merchantKinds } from "../shared/merchant";

export type { MerchantKind, MerchantRow };
export type { Decision, TrialReport } from "../shared/merchant";
export { merchantRowKey as rowKey } from "../shared/merchant";
export type LibraryData = Record<MerchantKind, MerchantRow[]>;
export interface Library { data: LibraryData; fields: Record<MerchantKind, string[]>; publications?: string[] }
export const sections = merchantKinds;
export const catalog = {
  products: { name: "商品资料", unit: "个规格", add: "新增商品", description: "每个销售规格单独建档，记录客服可以引用的商品事实及出处。", columns: ["商品名称", "商品编码（SKU）", "规格或型号", "商品类别", "事实来源"] },
  orders: { name: "已售订单", unit: "条明细", add: "新增订单明细", description: "按成交时的商品规格、会员和物流记录查单。同一订单可录入多条商品明细。", columns: ["订单号", "行号", "成交商品与规格", "店铺会员编号", "下单时间", "物流状态"] },
  policies: { name: "政策版本", unit: "个版本", add: "新增政策草稿", description: "按下单时间匹配条款。用两笔订单试算草稿，核对变化后发布。", columns: ["名称", "条款编号", "版本", "生效时间（含）", "天数", "发布状态"] },
  faqs: { name: "常见问答", unit: "条问答", add: "新增问答", description: "维护顾客常用问法、标准答复及来源，已审核的答复可供客服引用。", columns: ["顾客常用问法", "问答编号", "版本", "依据或来源", "状态"] },
} satisfies Record<MerchantKind, {name: string; unit: string; add: string; description: string; columns: string[]}>;

export interface WriteResult { ok: boolean; errors: string[]; warnings?: string[]; changes: number }
export interface ImportPreview extends WriteResult {
  previewToken?: string;
  counts: Record<MerchantKind, number>;
  samples: Partial<LibraryData>;
}
export interface Trial extends TrialReport { token: string }

export async function merchantRequest<T>(path = "", payload?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const isFile = payload instanceof File;
  const response = await fetch("/api/merchant" + path, payload === undefined ? { cache: "no-store" } : {
    method: "POST",
    headers: { "Content-Type": isFile ? "application/octet-stream" : "application/json", ...extraHeaders },
    body: isFile ? payload : JSON.stringify(payload),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const messages = Array.isArray(data?.errors) ? data.errors.join("\n") : data?.error;
    throw new Error(messages || "读取店铺资料失败，请刷新后重试。");
  }
  if (!data) throw new Error("服务未返回资料，请重试。");
  return data as T;
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请重试。";
}
export const published = (row: MerchantRow) => row["发布状态"] === "已发布";
export const policyKeyOf = (row: MerchantRow) => row["条款编号"] + "@" + row["版本"];
