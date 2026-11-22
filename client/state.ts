import type { Session, Snapshot } from "../shared/protocol";

export type CustomerSession = Session;
export interface DemoLogin { account: "A" | "B"; pin: string }

export const sessionKey = "support.customer.session";
export const agentKey = "support.agent.key";

export function latestSnapshot(previous: Snapshot | null, current: Snapshot): Snapshot {
  return previous?.id === current.id && previous.version > current.version ? previous : current;
}

export function getCustomerSession(): CustomerSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(sessionKey) ?? "null");
    return isCustomerSession(value) ? value : null;
  } catch {
    return null;
  }
}

function isCustomerSession(value: unknown): value is CustomerSession {
  return (
    !!value && typeof value === "object" &&
    "id" in value && typeof value.id === "string" && value.id.length > 0 &&
    "token" in value && typeof value.token === "string" && value.token.length > 0
  );
}

export async function createCustomerSession(credentials?: DemoLogin): Promise<CustomerSession> {
  const response = await fetch("/api/conversations", {
    method: "POST",
    ...(credentials && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(credentials) }),
    signal: AbortSignal.timeout(12000),
  });
  if (credentials && (response.status === 401 || response.status === 403)) {
    throw new Error("测试账号或口令有误，请重新输入。");
  }
  if (!response.ok) throw new Error("暂时无法开始会话，请重试。");
  const value: unknown = await response.json();
  if (!isCustomerSession(value)) throw new Error("暂时无法开始会话，请重试。");
  return value;
}

export function getAgentKey(): string {
  const params = new URLSearchParams(location.hash.slice(1));
  const sharedKey = params.get("key")?.trim();
  if (params.has("key")) {
    params.delete("key");
    const remaining = params.toString();
    history.replaceState(history.state, "", location.pathname + location.search + (remaining ? "#" + remaining : ""));
  }
  return sharedKey || sessionStorage.getItem(agentKey) || "";
}

export function makeRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export const messageTime = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function conversationLabel(id: string) {
  return "会话 " + id.slice(-6).toUpperCase();
}
