import { useRef, useState, type FormEvent } from "react";
import type { CommerceState, DemoAccount } from "../shared/commerce";
import type { Mode } from "../shared/protocol";
import { makeRequestId, type DemoLogin } from "./state";
import type { CommerceQuery } from "./useLiveFeed";
import { Icon, Notice } from "./ui";
import { CopyTraceId } from "./CopyTraceId";
import { DemoCheckout } from "./DemoCheckout";
import type { CustomerSession } from "./state";
import "./commerce.css";

interface PanelProps {
  state?: CommerceState;
  sessionLabel?: string;
  session?: CustomerSession | null;
  mode: Mode;
  disabled: boolean;
  starting: boolean;
  start: (credentials?: DemoLogin) => Promise<void>;
  query: (query: CommerceQuery, requestId: string) => Promise<void>;
}

export function CommercePanel({ state, sessionLabel, session, mode, disabled, starting, start, query }: PanelProps) {
  const account = state?.account;
  const [mobileOpen, setMobileOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [loginAccount, setLoginAccount] = useState<DemoAccount>(account === "A" ? "B" : "A");
  const [pin, setPin] = useState("");
  const [loginError, setLoginError] = useState("");
  const [section, setSection] = useState<"order" | "faq" | null>(null);
  const [selected, setSelected] = useState("");
  const [manual, setManual] = useState(false);
  const [entered, setEntered] = useState("");
  const [lineNumber, setLineNumber] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const currentSection = section ?? (account ? "order" : "faq");
  const blocked = disabled || pending || starting || mode !== "ai";
  const selectedOrder = selected || state?.orders[0]?.id || "";
  const orderId = (manual ? entered : selectedOrder).trim();
  const lines = state?.orders.find(order => order.id === orderId.toUpperCase())?.lines;
  const item = lines?.find(item => String(item.line) === lineNumber);
  const count = Number(quantity);
  const validCount = !item || (Number.isSafeInteger(count) && count > 0 && count <= item.quantity);
  function resetLine() { setLineNumber(""); setQuantity("1"); }

  const login = async (event: FormEvent) => {
    event.preventDefault();
    if (starting || !pin.trim()) return;
    setLoginError("");
    try {
      await start({ account: loginAccount, pin: pin.trim() });
    } catch (failure) {
      setLoginError(failure instanceof Error ? failure.message : "登录失败，请重试。");
    }
  };

  const runQuery = async (input: CommerceQuery) => {
    if (blocked || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    const key = JSON.stringify(input);
    const next = attempt.current?.key === key ? attempt.current : { key, id: makeRequestId() };
    attempt.current = next;
    try {
      await query(input, next.id);
      attempt.current = null;
      setMobileOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "查询失败，请重试。");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return <aside className="commerce-panel" aria-label="订单与售后" data-mobile-open={mobileOpen}>
    <div className="commerce-panel-heading">
      <div><h2>订单与售后</h2><p>演示店铺 · 模拟订单</p></div>
      <button type="button" className="commerce-mobile-toggle" aria-expanded={mobileOpen}
        aria-controls="commerce-controls" onClick={() => setMobileOpen(!mobileOpen)}>{mobileOpen ? "收起" : "展开"}</button>
    </div>
    <div className="commerce-panel-scroll" id="commerce-controls">
      <section className="commerce-identity" aria-label="顾客身份">
        <div className="commerce-identity-line"><span><Icon name="person" width="16" height="16" />{account ? "测试账号 " + account : "访客"}</span>
          {account && <button type="button" className="link-button" onClick={() => {
            setSwitching(!switching); setLoginAccount(account === "A" ? "B" : "A"); setPin(""); setLoginError("");
          }}>
            {switching ? "取消切换" : "切换账号"}</button>}
        </div>
        {(!account || switching) && <form className="commerce-login" onSubmit={login}>
          <label>测试账号<select value={loginAccount} onChange={event => { setLoginAccount(event.target.value as DemoAccount); setPin(""); }}>
            <option value="A">账号 A</option><option value="B">账号 B</option>
          </select></label>
          <label>测试口令<input type="password" inputMode="numeric" maxLength={4} value={pin}
            onChange={event => setPin(event.target.value)} required autoComplete="off" aria-describedby="demo-login-hint" /></label>
          <p className="commerce-help" id="demo-login-hint">账号 {loginAccount} 的演示口令为 <b>{loginAccount === "A" ? "1111" : "2222"}</b>。登录后开始独立会话。</p>
          {loginError && <Notice error>{loginError}</Notice>}
          <button className="secondary-button" type="submit" disabled={starting || !pin.trim()}>{starting ? "正在连接" : "登录测试账号"}</button>
          {account && <button type="button" className="link-button" disabled={starting} onClick={() => void start()}>以访客开始新会话</button>}
        </form>}
      </section>
      {mode === "ai" ? <section className="commerce-query" aria-label="店铺查询">
        <nav className="commerce-tabs" aria-label="查询类型">
          <button type="button" aria-pressed={currentSection === "order"} onClick={() => setSection("order")}>我的订单</button>
          <button type="button" aria-pressed={currentSection === "faq"} onClick={() => setSection("faq")}>常见问题</button>
        </nav>
        {currentSection === "order" ? account ? <div className="commerce-query-body">
          {manual ? <label>订单号<input value={entered} maxLength={64} onChange={event => {setEntered(event.target.value); resetLine();}} placeholder="输入订单号" /></label>
            : <label>选择本人订单<select value={selectedOrder} onChange={event => {setSelected(event.target.value); resetLine();}}>
              {state?.orders.map(order => <option key={order.id} value={order.id}>{order.id} · {order.label}</option>)}
            </select></label>}
          <button type="button" className="link-button commerce-change-order" onClick={() => {setManual(!manual); resetLine();}}>
            {manual ? "从本人订单中选择" : "手动输入订单号"}</button>
          {!!lines?.length && <label>退货范围<select value={lineNumber} onChange={event => {setLineNumber(event.target.value); setQuantity("1");}}>
            <option value="">整笔订单</option>
            {lines.map(line => <option key={line.line} value={line.line}>第 {line.line} 行 · {line.description}（共 {line.quantity} 件）</option>)}
          </select></label>}
          {item && <label>申请数量<input type="number" min="1" max={item.quantity} step="1" value={quantity}
            aria-invalid={!validCount} onChange={event => setQuantity(event.target.value)}/>
            {!validCount && <span className="commerce-help">请输入 1 到 {item.quantity} 之间的整数。</span>}
          </label>}
          <div className="commerce-order-actions">
            <button type="button" className="secondary-button" disabled={blocked || !orderId}
              onClick={() => void runQuery({ action: "order", orderId })}>查订单物流</button>
            <button type="button" className="primary-button" disabled={blocked || !orderId || !validCount}
              onClick={() => void runQuery({ action: "return", orderId, ...(item ? { line:item.line, quantity:count } : {}) })}>判断能否退货</button>
          </div>
          {session && <DemoCheckout session={session} disabled={blocked} onOrder={id=>{setManual(false);setSelected(id);resetLine();}}/>}
        </div> : <p className="commerce-help">登录测试账号后，可以查询本人的订单和退货期限。</p> :
          <form className="commerce-query-body" onSubmit={event => { event.preventDefault(); if (question.trim()) void runQuery({ action: "faq", text: question.trim() }); }}>
            <label>店铺常见问题<input value={question} onChange={event => setQuestion(event.target.value)} maxLength={300} placeholder="输入想查询的问题" /></label>
            <div className="commerce-faq-links">{["退货怎么申请？", "退货期限怎么算？"].map(text =>
              <button key={text} type="button" className="link-button" disabled={blocked} onClick={() => void runQuery({ action: "faq", text })}>{text}</button>)}</div>
            <button className="secondary-button" type="submit" disabled={blocked || !question.trim()}>查询店铺条款</button>
          </form>}
        {pending && <Notice>正在查询…</Notice>}
        {error && <Notice error>{error}</Notice>}
      </section> : <p className="commerce-active-human">坐席可在当前会话查看已核实的订单和政策。</p>}
      {state && <div className="commerce-simulation"><p className="commerce-clock"><Icon name="clock" width="15" height="15" /><span>模拟办理时间（北京时间）<br /><strong>{state.asOf}</strong></span></p>
        <p className="commerce-help">这里可查询退货资格。实际退货需在店铺办理。</p></div>}
      {sessionLabel && <p className="commerce-session">{sessionLabel} {session && <CopyTraceId value={"TR-"+session.id} />}</p>}
    </div>
  </aside>;
}
