import { Fragment, useState, type ComponentProps } from "react";
import type { DiagnosticEvent, DiagnosticReport, DiagnosticSession, FlowStage, FlowStageId, ModuleStatus, StageState } from "../shared/diagnostics";
import { conversationLabel } from "./state";
import { Icon } from "./ui";
import type { Connection } from "./useLiveFeed";
import { ModuleMap } from "./ModuleMap";
import { traceLink } from "./trace-links";
import "./flow-monitor.css";

interface MonitorProps {
  report: DiagnosticReport | null;
  connection: Connection;
  error: string;
  selectedId: string;
  onSelect: (id: string) => void;
  search: string;
  onSearch: (value: string) => void;
  onRefresh: () => void;
  initialView?: 'modules' | 'session';
}

type IconName = ComponentProps<typeof Icon>["name"];
const stages: { id: FlowStageId; name: string; icon: IconName; module: string }[] = [
  { id: "customer", name: "建立会话", icon: "chat", module: "会话存储 · SQLite" },
  { id: "ai", name: "AI 应答", icon: "sparkle", module: "模型调用 · AI SDK / DeepSeek" },
  { id: "queue", name: "转人工排队", icon: "clock", module: "接待状态 · 会话路由" },
  { id: "agent", name: "坐席接单", icon: "headset", module: "坐席工作台 · 会话路由" },
  { id: "reply", name: "人工回复", icon: "send", module: "回复存储与推送 · SQLite / Socket.IO" },
];
const edgeLabels = ["提问", "转接", "接单", "回复"];
const modeNames = { ai: "AI 接待", waiting: "等待接待", human: "人工接待", resolved: "已办结" } as const;
const stateNames: Record<StageState, string> = {
  pending: "待触发", active: "运行中", done: "已完成", failed: "异常", skipped: "已跳过", cancelled: "已中止", unknown: "记录不足",
};
const idleSteps: FlowStage[] = stages.map(({ id, name }) => ({id, label: name, state: "pending", at: null, detail: "选择一个会话后可查看该节点的运行记录。"}));
const shortTime = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const dateTime = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function Time({ value, date = false }: { value: number; date?: boolean }) {
  return <time dateTime={new Date(value).toISOString()} title={dateTime.format(value)}>{(date ? dateTime : shortTime).format(value)}</time>;
}

function stateLabel(node: FlowStage) {
  if (node.state === "active" && node.id === "queue") return "等待接单";
  if (node.state === "active" && node.id === "ai") return "应答中";
  return stateNames[node.state];
}

function StagePill({ step, empty }: { step: FlowStage; empty?: boolean }) {
  return <span className="fm-pill" data-tone={empty ? "pending" : step.state}><i aria-hidden="true" />{empty ? "无会话" : stateLabel(step)}</span>;
}

function defaultStep(session: DiagnosticSession | null) {
  if (!session) return "customer";
  const steps = session.stages;
  return steps.find(s => s.state === "failed")?.id ?? [...steps].reverse().find(s => s.state === "active" || s.state === "done")?.id ?? "customer";
}

const visited = (step: FlowStage | undefined) => !!step && ["done", "active", "failed", "cancelled"].includes(step.state);

function EventList({ events, forStage, onAll, limited }: { events: DiagnosticEvent[]; forStage: string; onAll: () => void; limited: boolean }) {
  const [showMore, setShowMore] = useState(false);
  const recent = showMore ? [...events].reverse() : events.slice(-6).reverse();
  return <section className="fm-card fm-events" aria-label="会话事件">
    <header className="fm-section-head"><div><h2>会话事件</h2><p>{forStage ? `${forStage} · 最近发生在前` : "最近发生在前"}</p></div>
      {forStage && <button type="button" className="link-button" onClick={onAll}>查看全部节点</button>}
    </header>
    {events.length === 0 ? <p className="fm-empty-line">{forStage ? "该节点还没有事件记录。" : "这个会话还没有事件记录。"}</p> : <ol className="fm-event-list">
      {recent.map((e, i) => <li key={`${e.at}/${e.event}/${i}`} data-failed={e.failed}>
        <Time value={e.at} date /><div><strong>{e.label}</strong>{e.detail && <p>{e.detail}</p>}<code>{e.module} · {e.event}</code></div>
      </li>)}
    </ol>}
    {events.length > 6 && <button type="button" className="link-button fm-more" onClick={() => setShowMore(!showMore)}>{showMore ? "收起记录" : `查看其余 ${events.length - 6} 条`}</button>}
    {limited && <p className="fm-footnote">此处展示可用的近期记录。</p>}
  </section>;
}

function Modules({ modules }: { modules: ModuleStatus[] }) {
  return <section className="fm-card fm-modules" aria-label="模块运行情况">
    <header className="fm-section-head"><div><h2>模块运行情况</h2><p>当前服务实例</p></div></header>
    {modules.length === 0 && <p className="fm-empty-line">等待服务返回检查结果。</p>}
    <ul>{modules.map(module => <li key={module.id} data-module={module.id}>
      <div className="fm-module-row"><strong>{module.label}</strong><span className="fm-pill" data-tone={module.state}><i aria-hidden="true" />{module.status}</span></div>
      <p>{module.detail}</p>{module.at !== null && <span className="fm-module-time">观测于 <Time value={module.at} date /></span>}
    </li>)}</ul>
  </section>;
}

function SessionFlow({ session, modules, report, view }: { session: DiagnosticSession | null; modules: ModuleStatus[]; report: DiagnosticReport | null; view: 'modules' | 'session' }) {
  const [picked, setPicked] = useState<FlowStageId | null>(null);
  const [filterEvents, setFilterEvents] = useState(false);
  const steps = session?.stages ?? idleSteps;
  const selected = steps.find(s => s.id === (picked ?? defaultStep(session))) ?? steps[0];
  const selectedInfo = stages.find(s => s.id === selected.id)!;
  const ai = steps.find(s => s.id === "ai");
  const queue = steps.find(s => s.id === "queue");
  const bypass = ai?.state === "skipped" && visited(queue);
  const allEvents = session?.events ?? [];
  const events = filterEvents ? allEvents.filter(e => e.stage === selected.id) : allEvents;

  return <>
    {view === 'modules' ? <ModuleMap report={report} /> : <section className="fm-card fm-flow" aria-labelledby="fm-flow-heading">
      <header className="fm-section-head"><div><h2 id="fm-flow-heading">会话流程图</h2><p>{session ? `${conversationLabel(session.id)} · ${modeNames[session.mode]}` : "尚未选择会话"}</p></div>
        <span className="fm-instruction">点选节点查看记录</span>
      </header>
      <div className="fm-canvas"><div className="fm-map" role="group" aria-label="建立会话后，可先由 AI 应答再转人工，或直接排队；坐席接单后回复。">
        <div className="fm-branch" data-active={bypass}><span>直接转人工</span></div>
        {steps.map((step, i) => <Fragment key={step.id}>
          {i > 0 && <div className="fm-edge" data-at={i} data-active={!!session && visited(step) && visited(steps[i - 1])} aria-hidden="true"><span>{edgeLabels[i - 1]}</span><i /></div>}
          <button className="fm-node" type="button" data-node={step.id} data-tone={session ? step.state : "pending"} aria-pressed={selected.id === step.id} onClick={() => { setPicked(step.id); setFilterEvents(true); }}>
            <span className="fm-node-icon"><Icon name={stages[i].icon} width="19" height="19" /></span>
            <strong>{step.label}</strong><StagePill step={step} empty={!session} />
          </button>
        </Fragment>)}
      </div></div>
      <div className="fm-node-detail" aria-label="节点详情">
        <div><h3>{selected.label}</h3><span>{selectedInfo.module}</span></div>
        <div><p>{selected.detail}</p>{selected.at !== null && <Time value={selected.at} date />}</div>
      </div>
    </section>}
    <div className="fm-lower">
      <EventList key={view === 'session' && filterEvents ? selected.id : 'all'} events={view === 'session' ? events : allEvents} forStage={view === 'session' && filterEvents ? selected.label : ""} onAll={() => setFilterEvents(false)} limited={session?.historyLimited ?? false} />
      <Modules modules={modules} />
    </div>
  </>;
}

export function FlowMonitor({ report, connection, error, selectedId, onSelect, search, onSearch, onRefresh, initialView = 'modules' }: MonitorProps) {
  const [view, setView] = useState<'modules' | 'session'>(initialView);
  const session = report?.selected ?? null;
  const options = report?.sessions ?? [];
  const showSelected = session && !options.some(item => item.id === session.id);
  const hasSnapshot = report !== null;
  return <main className="flow-monitor">
    <header className="fm-title"><div><h1>流程监控</h1><div className="fm-sync">{report ? <span>上次更新 <Time value={report.checkedAt} /></span> : <span>正在读取诊断记录…</span>}</div></div>
      <button type="button" className="secondary-button" onClick={onRefresh}>刷新状态</button>
    </header>
    {error || connection === "offline" || connection === "unauthorized" ? <p className="fm-warning" role="status">{error || (connection === "unauthorized" ? "调试连接失效。" : "实时连接已断开。")}{hasSnapshot ? " 以下是上次收到的记录。" : " 等待重新连接。"}</p> : null}
    <section className="fm-controls" aria-label="选择要检查的会话">
      <label><span>查询编号</span><input type="search" placeholder="输入会话编号末六位" maxLength={36} value={search} onChange={e => onSearch(e.target.value)} autoComplete="off" spellCheck={false} /></label>
      <label><span>{search ? "查询结果" : "近期会话"}</span><select aria-label="检查会话" disabled={!options.length && !showSelected} value={session?.id ?? selectedId ?? ""} onChange={e => onSelect(e.target.value)}>
        {!session && <option value="">{!report ? "正在读取会话…" : options.length ? "选择会话" : search ? "没有匹配的会话" : "暂无会话"}</option>}
        {showSelected && <option value={session.id}>{conversationLabel(session.id)} · {modeNames[session.mode]}</option>}
        {options.map(item => <option key={item.id} value={item.id}>{conversationLabel(item.id)} · {modeNames[item.mode]} · {dateTime.format(item.updatedAt)}</option>)}
      </select></label>
      {session && <a className="link-button" href={traceLink("TR-"+session.id,session.id)}>查看本会话日志</a>}
    </section>
    <nav className="fm-views" aria-label="检查视图"><button type="button" aria-pressed={view === 'modules'} onClick={() => setView('modules')}>模块地图</button><button type="button" aria-pressed={view === 'session'} onClick={() => setView('session')}>会话轨迹</button><a href={traceLink("",session?.id)}>流程日志</a></nav>
    <SessionFlow key={session?.id ?? "empty"} session={session} modules={report?.modules ?? []} report={report} view={view} />
  </main>;
}
