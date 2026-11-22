import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "../shared/protocol";
import { createCustomerSession, getCustomerSession, latestSnapshot, sessionKey, conversationLabel, type CustomerSession, type DemoLogin } from "./state";
import { CommercePanel } from "./CommercePanel";
import { Transcript } from "./Transcript";
import { AppHeader, ConnectionStatus, Icon, Notice } from "./ui";
import { useLiveFeed } from "./useLiveFeed";

const suggestions = ["你能帮我做什么？", "怎么联系人工？"];

const currentService = {
  ai: { name: "AI 客服接待中", detail: "客服助手", icon: "sparkle" },
  waiting: { name: "等待人工接入", detail: "已申请人工客服", icon: "clock" },
  human: { name: "人工客服接待中", detail: "人工客服", icon: "headset" },
  resolved: { name: "已办结", detail: "仍可在这里追问", icon: "check" },
} as const;

export function Customer() {
  const [session, setSession] = useState<CustomerSession | null>(getCustomerSession);
  const [starting, setStarting] = useState(!session);
  const [startError, setStartError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pendingAction, setPendingAction] = useState<"handoff"|"resolve"|null>(null);
  const requesting = pendingAction !== null;
  const creating = useRef(false);
  const auth = useMemo(() => session ? { role: "customer" as const, ...session } : null, [session]);
  const { feed, connection, reconnect, request, reportView } = useLiveFeed<Snapshot>(auth, "snapshot", latestSnapshot);
  const snapshot = feed?.id === session?.id ? feed : null;

  const start = useCallback(async (credentials?: DemoLogin) => {
    if (creating.current) return;
    creating.current = true;
    setStartError("");
    setStarting(true);
    try {
      const created = await createCustomerSession(credentials);
      try {
        localStorage.setItem(sessionKey, JSON.stringify(created));
      } catch { /* The open conversation can continue if storage is unavailable. */ }
      setSession(created);
      setActionError("");
    } catch (failure) {
      const problem = failure instanceof Error && failure.message.startsWith("测试账号") ? failure.message : "暂时无法开始会话，请重试。";
      if (credentials) throw new Error(problem);
      setStartError(problem);
    } finally {
      creating.current = false;
      setStarting(false);
    }
  }, []);

  const hadSession = useRef(!!session);
  useEffect(() => {
    if (!hadSession.current) void start();
  }, [start]);

  const updateMode = async (action:"handoff"|"resolve") => {
    if (requesting || connection !== "online" || snapshot?.mode !== "ai") return;
    setActionError("");
    setPendingAction(action);
    try {
      if (action === "handoff") await request("customer:handoff", {});
      else await request("customer:resolve", {version:snapshot.version});
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "会话暂时无法更新，请重试。");
    } finally {
      setPendingAction(null);
    }
  };

  const onSend = useCallback((text: string, requestId: string) =>
    request("customer:send", { text, requestId }), [request]);

  const mode = snapshot?.mode ?? "ai";
  const service = currentService[mode];
  const unauthorized = connection === "unauthorized";
  const offline = connection === "offline";
  const placeholder = mode === "waiting" ? "补充你的问题…" : mode === "human" ? "发送给人工客服…" : mode === "resolved" ? "在原会话继续追问…" : "输入你的问题…";

  return (
    <div className="app">
      <AppHeader>
        <a className="header-link" href="/agent"><Icon name="headset" width="16" height="16" />坐席台<Icon name="arrow" width="14" height="14" /></a>
      </AppHeader>

      <main className="customer-layout customer-commerce-layout">
        <CommercePanel key={session?.id ?? "connecting"} session={session} state={snapshot?.commerce} mode={mode}
          sessionLabel={snapshot ? conversationLabel(snapshot.id) : undefined}
          disabled={!snapshot || requesting || snapshot.generating || connection !== "online"} starting={starting}
          start={start} query={(query, requestId) => request("customer:commerce", { ...query, requestId })} />

        <section className="chat-panel" aria-labelledby="customer-title">
          <header className="panel-header customer-panel-header">
            <span className="service-avatar" data-mode={mode}><Icon name={service.icon} width="22" height="22" /></span>
            <div className="panel-title">
              <h1 id="customer-title">在线客服</h1>
              <p>{snapshot ? service.detail : "正在准备会话"}</p>
            </div>
            <div className="panel-actions">
              {mode === "ai" && <button type="button" className="secondary-button handoff-button" onClick={()=>void updateMode("handoff")} disabled={!snapshot || starting || requesting || connection !== "online"}>
                <Icon name="headset" width="16" height="16" />
                {pendingAction === "handoff" ? "正在转接" : "转人工"}
              </button>}
              {mode !== "ai" && <span className="mode-badge" data-mode={mode}><span />{service.name}</span>}
            </div>
          </header>

          <div className="chat-status">
            <ConnectionStatus connection={connection} />
            {snapshot && mode === "ai" && <span className="mode-badge" data-mode={mode}><span />{service.name}</span>}
            {mode==="ai" && !snapshot?.generating && snapshot?.messages.at(-1)?.role==="assistant" &&
              <button type="button" className="link-button" disabled={starting || requesting || connection!=="online"}
                onClick={()=>void updateMode("resolve")}>{pendingAction==="resolve" ? "正在确认" : "问题已解决"}</button>}
            {offline && <button type="button" className="link-button" onClick={reconnect}>重新连接</button>}
            {unauthorized && snapshot && <button type="button" className="link-button" disabled={starting} onClick={() => void start()}>开始新会话</button>}
          </div>

          {actionError && mode === "ai" && <div className="panel-notice"><Notice error>{actionError}</Notice></div>}
          {startError && snapshot && <div className="panel-notice"><Notice error>{startError}</Notice></div>}

          <Transcript
            key={session?.id}
            snapshot={snapshot}
            onView={reportView}
            disabled={!snapshot || starting || requesting || connection !== "online"}
            label="聊天记录"
            placeholder={placeholder}
            onSend={onSend}
            explainReturns
            suggestions={mode === "ai" ? suggestions : undefined}
            empty={
              <div className="customer-welcome">
                <span className="welcome-icon"><Icon name="sparkle" width="28" height="28" /></span>
                <h2>{starting ? "正在连接客服" : unauthorized ? "会话已失效" : "你好，需要什么帮助？"}</h2>
                {startError ? (
                  <><Notice error>{startError}</Notice><button type="button" className="secondary-button" onClick={() => void start()}>重试</button></>
                ) : unauthorized ? (
                  <button type="button" className="secondary-button" disabled={starting} onClick={() => void start()}>开始新会话</button>
                ) : (
                  <p>{starting ? "很快就可以开始咨询。" : "在下方输入问题，我来帮你。"}</p>
                )}
              </div>
            }
            composerNotice={connection === "online" && (mode === "waiting" ? <Notice>人工客服接入后，会在这里回复你。</Notice> :
              mode === "resolved" ? <Notice>本次咨询已办结。发送追问后，原会话会进入人工队列。</Notice> : null)}
          />
        </section>
      </main>
    </div>
  );
}
