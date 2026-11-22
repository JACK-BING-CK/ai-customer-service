import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { Snapshot } from "../shared/protocol";
import { agentKey, conversationLabel, getAgentKey, messageTime } from "./state";
import { CopyTraceId } from "./CopyTraceId";
import { traceLink } from "./trace-links";
import { Transcript } from "./Transcript";
import { CommerceHandoff } from "./CommerceCards";
import { AgentFeedback } from "./AgentFeedback";
import { AppHeader, ConnectionStatus, Icon, Notice } from "./ui";
import { useLiveFeed } from "./useLiveFeed";

type Filter = "all" | "waiting" | "human" | "resolved";
const filters = [
  { id: "all", label: "全部待办" },
  { id: "waiting", label: "等待接待" },
  { id: "human", label: "接待中" },
] as const;
const queueEmpty: Snapshot[] = [];

export function Agent() {
  const [savedKey, setSavedKey] = useState(getAgentKey);
  const [token, setToken] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const archive = filter === "resolved";
  const auth = useMemo(() => ({ role: "agent" as const, token, archive }), [token,archive]);
  const { feed, connection, reconnect, request, reportView } = useLiveFeed<Snapshot[]>(auth, "queue");
  const [selectedId, setSelectedId] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [claiming, setClaiming] = useState("");
  const [claimError, setClaimError] = useState("");
  const [lastResolved, setLastResolved] = useState("");
  const [feedbackId, setFeedbackId] = useState("");

  const list = feed ?? queueEmpty;
  const visible = useMemo(() => list
    .filter((item) => filter === "all" ? item.mode !== "resolved" : item.mode === filter)
    .sort((a, b) => {
      if (a.mode !== b.mode) return a.mode === "waiting" ? -1 : 1;
      return a.mode === "waiting" ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt;
    }), [filter, list]);
  const active = visible.find((item) => item.id === selectedId) ?? visible[0] ?? null;
  const activeId = active?.id;
  const waitingCount = list.filter((item) => item.mode === "waiting").length;
  const humanCount = list.filter((item) => item.mode === "human").length;

  // Keep the displayed conversation selected when a new message reorders the queue.
  useEffect(() => {
    if (activeId) setSelectedId(activeId);
  }, [activeId]);

  useEffect(() => {
    if (connection === "unauthorized" && !token && savedKey) {
      setToken(savedKey);
      return;
    }
    if (token && connection === "online") sessionStorage.setItem(agentKey, token);
    if (token && connection === "unauthorized") sessionStorage.removeItem(agentKey);
  }, [token, savedKey, connection]);

  const signIn = (event: FormEvent) => {
    event.preventDefault();
    const next = keyInput.trim();
    if (!next) return;
    if (next === token) reconnect();
    else setToken(next);
    setKeyInput("");
    setClaimError("");
  };

  const signOut = () => {
    sessionStorage.removeItem(agentKey);
    setSavedKey("");
    setToken("");
    setSelectedId("");
    setFilter("all");
    setMobileOpen(false);
    setClaimError("");
  };

  const claim = async () => {
    if (!active || claiming || connection !== "online" || active.mode !== "waiting") return;
    const { id } = active;
    setClaimError("");
    setClaiming(id);
    // A queue update can arrive before the claim acknowledgement.
    setSelectedId(id);
    setFilter("all");
    try {
      await request("agent:claim", { id });
    } catch (error) {
      setClaimError(error instanceof Error ? error.message : "接待失败，请重试。");
    } finally {
      setClaiming("");
    }
  };

  const onSend = useCallback((text: string, requestId: string) => {
    if (!active) return Promise.reject(new Error("请先选择会话。"));
    return request("agent:send", { id: active.id, text, requestId });
  }, [active?.id, request]);

  const resolve = async () => {
    if (!active || claiming || active.mode !== "human" || connection !== "online") return;
    setClaimError("");
    setClaiming(active.id);
    try {
      await request("agent:resolve", {id:active.id, version:active.version});
      setLastResolved(active.id);
    } catch (error) {
      setClaimError(error instanceof Error ? error.message : "办结失败，请重试。");
    } finally {
      setClaiming("");
    }
  };

  const needKey = connection === "unauthorized" && (!!token || !savedKey);

  return (
    <div className="app agent-app">
      <AppHeader agent>
        <a className="header-link" href="/"><Icon name="back" width="16" height="16" />顾客端</a>
        {token && connection === "online" && <button type="button" className="header-link" onClick={signOut}><Icon name="leave" width="16" height="16" />退出</button>}
      </AppHeader>

      {needKey ? (
        <main className="access-layout">
          <form className="access-card" onSubmit={signIn}>
            <span className="welcome-icon"><Icon name="lock" width="24" height="24" /></span>
            <h1>进入坐席台</h1>
            <p>使用团队分配的坐席密钥，查看等待接待的顾客会话。</p>
            <label htmlFor="agent-key">坐席密钥</label>
            <input id="agent-key" name="agent-key" type="password" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} required autoComplete="current-password" />
            {token && <Notice error>坐席密钥无效，请检查后重试。</Notice>}
            <button type="submit" className="primary-button">进入坐席台 <Icon name="arrow" width="17" height="17" /></button>
          </form>
        </main>
      ) : (
        <main className="agent-layout" data-mobile-open={mobileOpen && !!active}>
          <aside className="queue-panel" aria-labelledby="queue-title">
            <div className="queue-header">
              <div><h1 id="queue-title">会话队列</h1><ConnectionStatus connection={connection} /></div>
              <button className="link-button" type="button" aria-pressed={archive} onClick={() => {
                setFilter(archive ? "all" : "resolved"); setClaimError("");
              }}>{archive ? "返回待办" : "已办结记录"}</button>
              {connection === "offline" && <button type="button" className="link-button" onClick={reconnect}>重新连接</button>}
            </div>
            {lastResolved && !archive && feed && !list.some(s => s.id === lastResolved) &&
              <p role="status" className="queue-confirmation">{conversationLabel(lastResolved)} 已办结，可在已办结记录中查看。</p>}
            {!archive && <nav className="queue-filters" aria-label="筛选会话">
              {filters.map(({ id, label }) => (
                <button key={id} type="button" aria-pressed={filter === id} onClick={() => { setFilter(id); setClaimError(""); }}>
                  {label}<span>{id === "all" ? waitingCount + humanCount : id === "waiting" ? waitingCount : humanCount}</span>
                </button>
              ))}
            </nav>}
            {archive && <h2 className="archive-heading">已办结记录</h2>}
            <div className="queue-items">
              {visible.map((item) => {
                const latest = item.messages.at(-1);
                return (
                  <button className="queue-item" key={item.id} type="button" aria-current={active?.id === item.id ? "true" : undefined} onClick={() => {
                    setSelectedId(item.id);
                    setMobileOpen(true);
                    setClaimError("");
                  }}>
                    <span className="queue-item-icon"><Icon name="chat" width="18" height="18" /></span>
                    <span className="queue-item-main">
                      <span className="queue-item-title"><strong>{conversationLabel(item.id)}</strong><time dateTime={new Date(item.updatedAt).toISOString()}>{messageTime.format(item.updatedAt)}</time></span>
                      <span className="queue-item-preview">{latest?.text || "还没有消息"}</span>
                      <span className="mode-badge" data-mode={item.mode}><span />{item.mode === "waiting" ? "等待接待" : item.mode === "resolved" ? "已办结" : "接待中"}</span>
                    </span>
                  </button>
                );
              })}
              {visible.length === 0 && <p className="queue-empty">{!feed ? "正在加载或等待重新连接。" : filter === "all" ? "有顾客转人工时，会出现在这里。" : "当前筛选下没有会话。"}</p>}
            </div>
          </aside>

          <section className="chat-panel agent-chat" aria-label="坐席会话">
            {active ? (
              <Fragment key={active.id}>
                <header className="panel-header agent-panel-header">
                  <button className="back-button" type="button" aria-label="返回会话队列" onClick={() => setMobileOpen(false)}><Icon name="back" /></button>
                  <span className="service-avatar"><Icon name="person" width="22" height="22" /></span>
                  <div className="panel-title">
                    <h2>{conversationLabel(active.id)}</h2>
                    <div className="agent-trace-tools"><CopyTraceId value={"TR-"+active.id} />
                      <a className="link-button" href={traceLink("TR-"+active.id,active.id)} target="_blank" rel="noreferrer">流程日志</a></div>
                    <p>{active.mode === "waiting" ? "顾客正在等待接待" : active.mode === "resolved" ? "已办结" : "人工接待中"}</p>
                  </div>
                  {active.mode === "waiting" && (
                    <button type="button" className="primary-button claim-button" onClick={claim} disabled={!!claiming || connection !== "online"}>
                      {claiming === active.id ? "正在接待" : "开始接待"}
                    </button>
                  )}
                  {active.mode === "human" && <button className="secondary-button" type="button" disabled={connection !== "online"} onClick={() => setFeedbackId(active.id)}>标记转人工原因</button>}
                  {active.mode === "human" && <button className="primary-button" type="button" disabled={!!claiming || connection !== "online"} onClick={resolve}>办结会话</button>}
                </header>

                {claimError && <div className="panel-notice"><Notice error>{claimError}</Notice></div>}

                <CommerceHandoff card={active.commerce?.latestCard} reason={active.handoffReason} />
                {active.mode === "human" && feedbackId === active.id && <AgentFeedback snapshot={active} token={token} onClose={() => setFeedbackId("")} />}

                <Transcript
                  snapshot={active}
                  onView={reportView}
                  disabled={connection !== "online" || active.mode === "resolved"}
                  draftOnly={active.mode !== "human"}
                  label="当前会话记录"
                  placeholder={active.mode === "waiting" ? "先写回复草稿…" : active.mode === "resolved" ? "已办结，记录可查阅" : "回复顾客…"}
                  onSend={onSend}
                  empty={<p className="queue-empty">顾客还没有发送消息。</p>}
                  composerNotice={connection !== "online" ? <Notice>当前连接不可用。重新连接后可继续接待。</Notice> : active.mode === "waiting" ? <Notice>可以先写草稿，点击「开始接待」后即可发送。</Notice> : undefined}
                />
              </Fragment>
            ) : (
              <div className="agent-empty">
                <span className="welcome-icon"><Icon name="chat" width="28" height="28" /></span>
                <h2>暂未选中会话</h2>
                <p>从会话队列选择顾客，即可查看聊天记录。</p>
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
