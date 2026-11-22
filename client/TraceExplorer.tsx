import { useEffect, useState } from "react";
import { traceDetailLabels, type TraceEvent, type TracePage } from "../shared/trace";
import { feedbackReasons } from "../shared/feedback";
import { mapLink, traceLink } from "./trace-links";
import { CopyTraceId } from "./CopyTraceId";
import type { Connection } from "./useLiveFeed";
import "./trace.css";

const formatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const results = {ok:"成功", blocked:"已拦截", error:"异常", info:"已记录"} as const;
const tones = {ok:"ok", blocked:"blocked", error:"error", info:"idle"} as const;
const valueLabels:Record<string,string> = {
  ...feedbackReasons, checkout:"顾客下单", manual:"后台录入", excel:"Excel 导入", history:"历史留存资料", login:"登录核验",
  order:"查询订单", return:"退货资格", faq:"常见问答", policy:"政策",
  verified:"已核验", login_required:"需要登录", invalid_login:"身份核验未通过", account_locked:"会话已绑定其他账号",
  lookup_started:"已开始查询", found:"已找到", line_found:"已核验指定商品行", invalid_line:"商品行或数量无效",
  select_line:"需要选择商品行", not_found:"未找到匹配记录", timeout:"超时", error:"执行异常",
  matched:"已命中条款", conflict:"存在条款冲突", missing_policy:"缺少适用条款", line_review:"明细需逐行核对",
  missing_fact:"缺少判断依据", condition_review:"条款条件需人工核对", eligible:"可申请退货", expired:"已过期",
  review:"需要人工核对", aborted:"已中止", provider_http:"模型服务异常", generation_error:"生成失败",
  unknown:"缺少原因", new_message:"收到新消息", human_handoff:"转人工接待", shutdown:"服务关闭",
  customer_handoff:"顾客点击转人工", customer_message:"顾客发消息转人工", ai_failure:"模型应答失败",
  commerce_review:"业务判断需人工核对", customer_reopened:"顾客追问重开", agent_claim:"坐席接单",
  agent_resolved:"坐席办结", customer_resolved:"顾客确认问题已解决", discarded:"会话状态变化，回复未写入",
  invalid_quantity:"数量须为 1 至 99 件", invalid_product:"商品编码格式无效", product_unavailable:"商品不可用，请重新选择",
  request_conflict:"该下单请求已用于其他商品或数量", invalid_request_id:"下单请求编号无效", checkout_error:"模拟订单保存失败",
  completed:"完成", cancelled:"已取消", failed:"失败", ok:"正常",
  replay_required:"需先回放", replay_failed:"回放未通过", stale_replay:"案例或资料已变化",
  version_changed:"版本已变化", already_published:"已发布", policy_trial_required:"需先试算政策",
  policy_conflict:"政策冲突", replay_blocked:"回放拦截", stale:"版本已过期", invalid:"资料无效",
  unavailable:"当前资料不可用", not_claimed:"需先接单",
};

function factValue(key:string,value:string|number|boolean) {
  if (key==="orderedAt" && typeof value==="number") return <TraceTime value={value}/>;
  if (key==="caseId") return <a href={"/merchant?case="+encodeURIComponent(String(value))+"#feedback"}>{String(value)}</a>;
  if (["source","code","reason","queryKind","target"].includes(key)) return valueLabels[String(value)] ?? String(value);
  return String(value);
}

function TraceTime({ value }: { value: number }) {
  return <time dateTime={new Date(value).toISOString()}>{formatter.format(value)}</time>;
}

function TraceId({ id, label, query, conversationId }: {
  id: string; label: string; query: string; conversationId?: string;
}) {
  return <div className="tr-id"><span className="tr-label">{label}</span>
    {query.toLowerCase() === id.toLowerCase() ? <code>{id}</code> :
      <a href={traceLink(id,conversationId)} title={"查询"+label+" "+id}><code>{id}</code></a>}
    <CopyTraceId value={id} label={"复制"+label} compact />
  </div>;
}

function TraceStep({ event, query }: {event:TraceEvent; query:string}) {
  const {order,conversationId} = event;
  return <article className="tr-step" data-status={event.status} data-event-id={event.id}>
    <div className="tr-step-top"><h3>{event.label}</h3><span className="fm-pill" data-tone={tones[event.status]}><i />{results[event.status]}</span>
      <TraceTime value={event.at} /></div>
    <TraceId id={event.id} label="步骤编号" query={query} conversationId={conversationId ?? undefined} />
    {event.flowId && <TraceId id={event.flowId} label="流程编号" query={query} conversationId={conversationId ?? undefined} />}
    <div className="tr-context">{order && <span>{event.flowId ? "关联订单" : "订单来源"} <a href={traceLink(order.orderId,conversationId ?? undefined)}>{order.orderId}</a> · {order.shop} · 账号 {order.owner}</span>}
      {conversationId && <a href={mapLink(conversationId)}>查看会话模块地图</a>}
      {conversationId && (event.details.messageId || event.details.causeMessageId) ?
        <a href={"/agent?traceEvent="+encodeURIComponent(event.id)} target="_blank" rel="noreferrer">在坐席台查看原消息</a> : null}</div>
    {!!Object.keys(event.details).length && <dl className="tr-facts">{Object.entries(event.details).map(([key,value])=>
      <div key={key}><dt>{traceDetailLabels[key] ?? key}</dt><dd>{factValue(key,value)}</dd></div>)}</dl>}
  </article>;
}

export function TraceResults({ page }: {page:TracePage}) {
  return <>
    {page.selectedEvent && <section className="tr-focus" aria-label="定位到的步骤"><h2>定位到的步骤</h2>
      <TraceStep event={page.selectedEvent} query={page.query} /></section>}
    <section aria-label="流程日志时间线">
      <header className="fm-section-head"><div><h2>{page.query ? "关联流程时间线" : "最近步骤"}</h2>
        <p>{page.query ? "按发生时间从早到晚" : "最近发生在前"} · 北京时间</p></div></header>
      {page.events.length ? <ol className="tr-timeline">{page.events.map(event=>
        <li key={event.id} data-focus={event.id === page.selectedEvent?.id}><TraceStep event={event} query={page.query}/></li>)}</ol>
        : <p className="fm-empty-line">{!page.query ? "暂无已编号的步骤。" : page.matched ? "此流程暂无可显示的步骤。" : "没有找到对应记录。请核对完整流程编号、步骤编号或订单号。"}</p>}
    </section>
    <p className="tr-coverage">持续编号开始于 <TraceTime value={page.coverageSince} />（北京时间）。{page.legacy && "此查询涉及早期记录，可追溯范围以当时留存的事实为准。"}</p>
  </>;
}

export function TraceExplorer({ query, token, connection, conversationId }: {
  query: string; token: string; connection: Connection; conversationId: string;
}) {
  const [cursors,setCursors] = useState<(number|undefined)[]>([undefined]);
  const [refresh,setRefresh] = useState(0);
  const [result,setResult] = useState<{page:TracePage;cursor?:number} | null>(null);
  const [error,setError] = useState("");
  const [loading,setLoading] = useState(true);
  const cursor = cursors.at(-1);
  useEffect(() => {
    const controller = new AbortController();
    setError(""); setLoading(true);
    const params = new URLSearchParams();
    if (query.trim()) params.set("q",query.trim());
    if (cursor !== undefined) params.set("cursor",String(cursor));
    let pending=false;
    async function read() {
      if (pending) return;
      pending=true;
      try {
        const response = await fetch("/api/debug/trace?"+params, {
          signal:controller.signal, cache:"no-store", headers:token ? {Authorization:"Bearer "+token} : {},
        });
        if (response.status===401 || response.status===403) throw Error("请使用本机调试后台的访问密钥重新进入。");
        const body = await response.json();
        if (!response.ok) throw Error(body.error || "日志查询失败，请重试。");
        if (!controller.signal.aborted) { setResult({page:body,cursor}); setError(""); }
      } catch(cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error && cause.message !== "Failed to fetch" ? cause.message : "暂时无法连接日志服务，请刷新重试。");
      } finally {
        pending=false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void read();
    const updateVisiblePage = () => {
      if (document.visibilityState==="visible") void read();
    };
    const timer = cursor===undefined ? window.setInterval(updateVisiblePage,5000) : undefined;
    if (cursor===undefined) document.addEventListener("visibilitychange",updateVisiblePage);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange",updateVisiblePage);
    };
  },[token,query,cursor,refresh,connection]);
  const page = result?.cursor === cursor ? result?.page : undefined;
  const focusId = page?.selectedEvent?.conversationId ?? (query.toUpperCase().startsWith("TR-") ? query.slice(3) : conversationId);
  const next = page?.nextCursor;
  return <main className="flow-monitor tr-explorer">
    <header className="fm-title"><h1>流程日志</h1><button className="secondary-button" type="button" disabled={loading} onClick={() => setRefresh(r=>r+1)}>刷新日志</button></header>
    <nav className="fm-views" aria-label="检查视图"><a href={mapLink(focusId)}>模块地图</a>
      <a href={mapLink(focusId,true)}>会话轨迹</a><a aria-current="page" href={traceLink("",focusId)}>流程日志</a></nav>
    <form className="tr-search" method="get" action="/debug" role="search">
      <label htmlFor="trace-query">流程编号、步骤编号或订单号</label>
      <div><input id="trace-query" name="trace" type="search" maxLength={160} defaultValue={query} autoComplete="off" spellCheck={false}
        placeholder="输入完整编号，例如 TR-…、EV-… 或订单号" />
        {focusId && <input type="hidden" name="conversation" value={focusId}/>}
        <button className="primary-button" type="submit">查询日志</button>
        {query && <a className="link-button" href={traceLink("",focusId)}>最近日志</a>}</div>
    </form>
    {error && <p className="fm-warning" role="alert">{error}</p>}
    <div className="fm-card" aria-busy={loading}>
      {page ? <TraceResults page={page} /> : loading && <p className="fm-empty-line" role="status">正在读取流程日志…</p>}
      {(cursors.length>1 || next!=null) && <nav className="tr-pagination" aria-label="日志分页">
        <button type="button" className="secondary-button" disabled={loading || cursors.length===1} onClick={()=>setCursors(c=>c.slice(0,-1))}>上一页</button>
        <span>第 {cursors.length} 页</span>
        <button type="button" className="secondary-button" disabled={loading || next==null} onClick={()=>{if(next!=null)setCursors(c=>[...c,next]);}}>下一页</button>
      </nav>}
    </div>
  </main>;
}
