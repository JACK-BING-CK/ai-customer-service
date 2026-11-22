import type { FeedbackCase, FeedbackExpected } from "../shared/feedback";
import { agentKey } from "./state";

export const decisionLabels = { eligible: "可申请退货", expired: "已超过退货期限", review: "需人工核对" };
export const caseLabels: Record<FeedbackCase["status"], string> = {
  new: "待处理", draft: "待回放", passed: "回放通过", blocked: "回放未通过", published: "已发布",
};

export function expectationLabel(expected: FeedbackExpected) {
  if (expected.kind === "faq") return expected.answer;
  if (expected.kind === "policy") return [decisionLabels[expected.status],
    expected.versions === undefined ? "条款版本未标注" : expected.versions.join("、") || "无适用版本",
    expected.deadline === undefined ? "截止时间未标注" : expected.deadline ?? "无截止时间",
  ].join(" · ");
  return "仅记录转人工原因";
}

export class FeedbackRequestError extends Error {
  code: string;
  constructor(message: string, code: string) { super(message); this.code = code; }
}

export async function feedbackRequest<T>(path: string, payload?: unknown, token?: string): Promise<T> {
  const credential = token ?? sessionStorage.getItem(agentKey);
  const headers: Record<string, string> = {};
  if (credential) headers.Authorization = "Bearer " + credential;
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch("/api/feedback" + path, {
    method: payload === undefined ? "GET" : "POST", cache: "no-store", headers,
    ...(payload !== undefined && { body: JSON.stringify(payload) }),
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) throw new Error("请在此标签页进入坐席工作台登录，再返回查看反馈。");
  if (!res.ok || !data) throw new FeedbackRequestError(data?.errors?.join("\n") || data?.error || "反馈资料暂时无法读取，请重试。", data?.code ?? "");
  return data as T;
}
