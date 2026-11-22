import { useId, useState, type ComponentProps } from "react";
import { traceLink } from "./trace-links";
import { feedbackModuleLabels, type BusinessModuleId, type DiagnosticReport, type DiagnosticSession, type FeedbackModuleId, type ModuleStatus, type ShopBlock, type StageState } from "../shared/diagnostics";
import { conversationLabel } from "./state";
import { Icon } from "./ui";
import "./module-map.css";

type ModuleId = 'customer' | 'chat' | 'realtime' | 'routing' | 'ai' | 'agent' | 'storage' | 'entry' | 'merchant' | BusinessModuleId | FeedbackModuleId;
type Observation = Pick<ModuleStatus, 'state' | 'status' | 'detail' | 'at'>;
type MapNode = { id: ModuleId; name: string; icon: ComponentProps<typeof Icon>['name']; files: string[] };
const map: MapNode[] = [
  { id: 'customer', name: '顾客窗口', icon: 'person', files: ['client/Customer.tsx', 'client/state.ts'] },
  { id: 'chat', name: '聊天呈现', icon: 'chat', files: ['client/Transcript.tsx'] },
  { id: 'entry', name: '服务入口与日志', icon: 'enter', files: ['server/main.ts', 'server/log.ts', 'shared/protocol.ts'] },
  { id: 'realtime', name: '实时通信', icon: 'send', files: ['client/useLiveFeed.ts', 'server/realtime.ts'] },
  { id: 'routing', name: '会话路由', icon: 'arrow', files: ['server/service.ts'] },
  { id: 'ai', name: 'AI 模型', icon: 'sparkle', files: ['server/ai.ts'] },
  { id: 'agent', name: '坐席工作台', icon: 'headset', files: ['client/Agent.tsx'] },
  { id: 'storage', name: '会话存储', icon: 'clock', files: ['server/store.ts'] },
  { id: 'identity', name: '身份核验', icon: 'lock', files: ['server/commerce.ts'] },
  { id: 'orders', name: '订单查询', icon: 'chat', files: ['server/commerce.ts', 'server/commerce-fixtures.ts'] },
  { id: 'policy', name: '条款检索', icon: 'workflow', files: ['server/commerce-rules.ts', 'server/commerce-fixtures.ts'] },
  { id: 'eligibility', name: '资格判断', icon: 'check', files: ['server/commerce-rules.ts'] },
  { id: 'merchant', name: '店铺资料管理', icon: 'workflow', files: ['client/Merchant.tsx', 'server/merchant-routes.ts', 'server/merchant-store.ts', 'server/merchant-xlsx.ts', 'server/diagnostic-merchant.ts'] },
  { id: 'feedback', name: feedbackModuleLabels.feedback, icon: 'headset', files: ['client/AgentFeedback.tsx', 'server/feedback-store.ts'] },
  { id: 'revision', name: feedbackModuleLabels.revision, icon: 'workflow', files: ['server/feedback-routes.ts', 'server/feedback-store.ts'] },
  { id: 'replay', name: feedbackModuleLabels.replay, icon: 'clock', files: ['server/feedback-replay.ts', 'server/diagnostic-feedback.ts'] },
  { id: 'publication', name: feedbackModuleLabels.publication, icon: 'check', files: ['server/feedback-store.ts', 'server/merchant-store.ts'] },
];
const unknown: Observation = {state:'unknown', status:'等待数据', detail:'等待调试服务返回此模块的观测记录。', at:null};

function observation(node: ModuleId, report: DiagnosticReport | null, feedbackChain: ModuleStatus[] | undefined): Observation {
  if (!report) return unknown;
  const { evidence, selected, checkedAt } = report;
  const c = evidence.connections;
  switch (node) {
    case 'entry': return { state: evidence.logReadable ? 'ok' : 'error', status: evidence.logReadable ? '已响应' : '日志读取失败',
      detail: evidence.logReadable ? '服务已处理本次检查，服务端运行日志可读取。' : '服务已响应，但未能读取运行日志，请检查日志目录和权限。', at: evidence.requestAt };
    case 'customer': {
      const count = selected ? c.selectedCustomers : c.customers;
      if (count === null) return { ...unknown, status:'待观测', detail:'暂时无法确定此会话的顾客连接数。' };
      return {state:count > 0 ? 'ok' : 'idle', status:count > 0 ? '已连接' : '当前无连接', detail:`${selected ? '所选会话' : '当前服务'}有 ${count} 个顾客实时连接。`, at:checkedAt};
    }
    case 'chat': {
      const cv = selected ? c.selectedCustomerViews : c.customerViews;
      const av = selected ? c.selectedAgentViews : c.agentViews;
      if (cv === null || av === null) return {...unknown, status:'待观测', detail:'尚未取得聊天组件的浏览器上报。'};
      return {state:cv + av ? 'ok' : 'idle', status:cv + av ? '已挂载' : '待观测',
        detail:`${selected ? '所选会话' : '当前服务'}已上报挂载 assistant-ui 聊天组件的页面：顾客端 ${cv} 个，坐席端 ${av} 个。`, at: checkedAt};
    }
    case 'agent': return {state: c.agents ? 'ok' : 'idle', status: c.agents ? '坐席在线' : '当前无连接', detail:`当前服务有 ${c.agents} 个坐席连接。`, at:checkedAt};
    case 'routing': {
      const latest = selected?.lifecycle?.at(-1);
      if (latest && selected) return {state:selected.mode === 'waiting' ? 'active' : 'ok',
        status:selected.mode === 'resolved' ? '已办结' : selected.mode === 'waiting' ? '重开待接单' : '重开已接待',
        detail:'可核对本会话的办结及追问重开记录。',at:latest.at};
      return report.modules.find(m => m.id === 'routing') ?? unknown;
    }
    case 'identity': case 'orders': case 'policy': case 'eligibility':
      if (selected) return selected.commerce?.find(m => m.id === node) ?? unknown;
      return report.modules.find(m => m.id === node) ?? unknown;
    case 'feedback': case 'revision': case 'replay': case 'publication':
      return feedbackChain?.find(m => m.id === node) ?? unknown;
    default: return report.modules.find(m => m.id === node) ?? unknown;
  }
}

const aiState: Record<StageState, string> = { pending:'待调用', active:'生成中', done:'已完成', failed:'生成失败', skipped:'已跳过', cancelled:'已中止', unknown:'记录不足' };
const sessionMode = { ai:'AI 接待', waiting:'等待坐席接单', human:'人工接待', resolved:'已办结' };

function SessionEvidence({ node, session }: { node: ModuleId; session: DiagnosticSession }) {
  let label = '';
  let detail = '';
  let at: number | null = null;
  if (node === 'ai') {
    const stage = session.stages.find(s => s.id === 'ai');
    if (!stage) return null;
    label = aiState[stage.state];
    detail = stage.detail;
    at = stage.at;
  } else if (node === 'routing') {
    label = sessionMode[session.mode];
    const change = session.events.findLast(e => e.module === 'conversation' && ['mode_changed','resolved','reopened'].includes(e.event));
    detail = change?.detail ?? '';
    at = change?.at ?? null;
  } else if (node === 'agent') {
    const stage = session.stages.find(s => s.id === 'agent');
    if (!stage) return null;
    detail = stage.detail;
    at = stage.at;
  } else return null;

  return <div className="dm-session-evidence"><span>{conversationLabel(session.id)}</span>{label && <strong>{label}</strong>}
    {detail && <p>{detail}</p>}{at !== null && <small>记录于 <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleString('zh-CN',{hour12:false})}</time></small>}
    {node === 'routing' && !!session.lifecycle?.length && <section aria-label="办结与重开"><h4>办结与重开</h4>
      <ol>{session.lifecycle.map((event,i) => <li key={i}>{event.by==='customer' ? '顾客确认问题已解决' : event.kind === 'resolved' ? '坐席办结' : '顾客追问，原会话重开'} · <time dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleString('zh-CN',{hour12:false})}</time></li>)}</ol>
    </section>}
  </div>;
}

// SVG connections share a coordinate system with the responsive grid of focusable buttons.
type Link = { from: ModuleId; to: ModuleId; name: string; path: string; label: [number, number] };
const wideLinks: Link[] = [
  {from:'customer',to:'chat',name:'输入',path:'M134 52H164',label:[150,39]},
  {from:'chat',to:'realtime',name:'收发',path:'M284 52H314',label:[300,39]},
  {from:'entry',to:'realtime',name:'挂载',path:'M466 52H436',label:[450,39]},
  {from:'realtime',to:'routing',name:'派发事件',path:'M375 79V127',label:[394,100]},
  {from:'routing',to:'ai',name:'调用模型',path:'M344 129V105H75V127',label:[166,96]},
  {from:'routing',to:'agent',name:'转人工',path:'M316 156H286',label:[300,143]},
  {from:'routing',to:'storage',name:'存取',path:'M434 156H464',label:[450,143]},
  {from:'routing',to:'identity',name:'查本人订单',path:'M344 183V209H75V231',label:[178,200]},
  {from:'routing',to:'policy',name:'查通用条款',path:'M375 183V231',label:[397,205]},
  {from:'identity',to:'orders',name:'按归属',path:'M134 260H164',label:[150,247]},
  {from:'orders',to:'policy',name:'选版本',path:'M284 260H314',label:[300,247]},
  {from:'policy',to:'eligibility',name:'算期限',path:'M434 260H464',label:[450,247]},
  {from:'merchant',to:'orders',name:'提供商品与订单',path:'M263 336V315H225V289',label:[202,315]},
  {from:'merchant',to:'policy',name:'提供条款与问答',path:'M337 336V315H375V289',label:[398,315]},
  {from:'agent',to:'feedback',name:'标记原因',path:'M202 183V195H7V468H15',label:[92,195]},
  {from:'feedback',to:'revision',name:'建草稿',path:'M134 468H164',label:[150,452]},
  {from:'revision',to:'replay',name:'试答',path:'M284 468H314',label:[300,452]},
  {from:'replay',to:'publication',name:'通过',path:'M434 468H464',label:[450,452]},
  {from:'publication',to:'merchant',name:'更新资料',path:'M525 441V364H375',label:[452,352]},
];
const narrowLinks: Link[] = [
  {from:'customer',to:'chat',name:'输入',path:'M270 43.5H327',label:[300,32]},
  {from:'chat',to:'realtime',name:'收发',path:'M450 70.5V101.5',label:[480,86]},
  {from:'entry',to:'realtime',name:'挂载',path:'M270 130.5H327',label:[300,119]},
  {from:'realtime',to:'routing',name:'派发',path:'M450 157.5V188.5',label:[480,174]},
  {from:'routing',to:'ai',name:'生成',path:'M330 217.5H273',label:[300,206]},
  {from:'routing',to:'agent',name:'接管',path:'M395 244.5V260H150V275.5',label:[255,251]},
  {from:'routing',to:'storage',name:'存取',path:'M450 244.5V275.5',label:[480,259]},
  {from:'routing',to:'identity',name:'查本人订单',path:'M395 244.5V260H300V349H150V362.5',label:[222,340]},
  {from:'routing',to:'policy',name:'查条款',path:'M570 217.5H585V478.5H572',label:[575,353]},
  {from:'identity',to:'orders',name:'按归属',path:'M270 391.5H327',label:[300,379]},
  {from:'orders',to:'policy',name:'选版本',path:'M450 418.5V449.5',label:[480,433]},
  {from:'policy',to:'eligibility',name:'算期限',path:'M330 478.5H273',label:[300,466]},
  {from:'merchant',to:'orders',name:'提供商品与订单',path:'M571 565.5H595V391.5H573',label:[545,527]},
  {from:'merchant',to:'policy',name:'提供条款与问答',path:'M450 538V508',label:[375,523]},
  {from:'agent',to:'feedback',name:'标记原因',path:'M30 304.5H9V652.5H28',label:[80,605]},
  {from:'feedback',to:'revision',name:'建草稿',path:'M270 652.5H327',label:[300,638]},
  {from:'revision',to:'replay',name:'试答',path:'M450 679.5V710.5',label:[480,696]},
  {from:'replay',to:'publication',name:'通过',path:'M330 739.5H273',label:[300,725]},
  {from:'publication',to:'merchant',name:'更新资料',path:'M150 767V777H585V576H573',label:[460,775]},
];

function Links({ narrow, selected }: { narrow?: boolean; selected: ModuleId }) {
  const arrow = useId();
  const links = narrow ? narrowLinks : wideLinks;
  const height = narrow ? 783 : 520;
  return <div aria-hidden="true" className={narrow ? 'dm-links dm-narrow' : 'dm-links dm-wide'}>
    <svg viewBox={`0 0 600 ${height}`} preserveAspectRatio="none" focusable="false"><defs><marker id={arrow} viewBox="0 0 7 7" refX="6" refY="3.5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 7 3.5 0 7Z" fill="context-stroke" /></marker></defs>
      {links.map(l => <path key={l.to + l.from} d={l.path} fill="none" data-related={l.to === selected || l.from === selected} vectorEffect="non-scaling-stroke" markerEnd={`url(#${arrow})`} />)}
    </svg>
    {links.map(l => <span key={l.to + l.from} style={{left:`${l.label[0]/6}%`,top:`${100 * l.label[1]/height}%`}}>{l.name}</span>)}
  </div>;
}

function ShopBlocks({ records }: { records: ShopBlock[] }) {
  return <section className="dm-blocks" aria-label="最近拦截记录">
    <h4>最近拦截记录</h4>
    <ol>{records.map((record, index) =>
      <li key={`${record.at}/${record.status}/${index}`}>
        <div className="dm-block-head"><strong>{record.status}</strong>
          <time dateTime={new Date(record.at).toISOString()}>{new Date(record.at).toLocaleString('zh-CN', { hour12: false })}</time>
        </div>
        {record.details.map((detail, i) => <p key={i}>{detail}</p>)}
        {record.feedbackCaseIds?.map(id=><a className="md-text-button" key={id} href={'/merchant?case='+encodeURIComponent(id)+'#feedback'}>打开差异案例 {id.slice(-6).toUpperCase()}</a>)}
      </li>
    )}</ol>
  </section>;
}

export function ModuleMap({ report }: { report: DiagnosticReport | null }) {
  const [picked, setPicked] = useState<ModuleId | null>(null);
  const [shopFeedback, setShopFeedback] = useState(false);
  const [caseId, setCaseId] = useState('');
  const sessionModules = report?.selected?.commerce ?? [];
  const businessIssue = sessionModules.find(m => m.state === 'error') ?? sessionModules.find(m => m.state === 'blocked');
  const latestBusiness = sessionModules.findLast(m => m.at !== null);
  const aiFailed = report?.selected?.stages.some(s => s.id === 'ai' && s.state === 'failed');
  const shop = report?.modules.find(m => m.id === 'merchant');
  const earlierCases = report?.selected?.otherFeedback;
  const earlierCase = earlierCases?.find(c => c.caseId === caseId);
  const feedbackChain = shopFeedback || !report?.selected
    ? report?.modules.filter(m => Object.hasOwn(feedbackModuleLabels, m.id)) : earlierCase?.modules ?? report.selected.feedback;
  const lastFeedback = feedbackChain?.findLast(m => m.at !== null);
  const lastLifecycleAt = report?.selected?.lifecycle?.at(-1)?.at;
  const recentRoute = lastLifecycleAt && lastLifecycleAt >= Math.max(lastFeedback?.at ?? 0,...sessionModules.map(m => m.at ?? 0));
  const selected = picked ?? (recentRoute ? 'routing' : undefined) ?? lastFeedback?.id ?? businessIssue?.id ?? (aiFailed ? 'ai' : undefined)
    ?? (shop?.state === 'blocked' ? 'merchant' : latestBusiness?.id)
    ?? map.find(n => observation(n.id, report, feedbackChain).state === 'error')?.id ?? 'routing';
  const item = map.find(n => n.id === selected)!;
  const info = observation(selected, report, feedbackChain);
  const feedbackNode = Object.hasOwn(feedbackModuleLabels, selected);
  const selectedFeedback = feedbackNode ? feedbackChain?.find(m => m.id === selected) : undefined;
  const blocks = selected === 'merchant' ? shop?.recentBlocks : selectedFeedback?.recentBlocks;
  const currentBlockShown = info.state === 'blocked' && blocks?.[0]?.at === info.at && blocks[0].status === info.status;
  const scopedBusiness = sessionModules.some(m => m.id === selected);
  const scope = feedbackNode ? (shopFeedback || !report?.selected ? '全店最近反馈' : earlierCase ? '本会话指定反馈' : '本会话最近反馈')
    : selected === 'merchant' ? '店铺级 · 全店操作' : report?.selected && (selected === 'customer' || selected === 'chat' || (selected === 'routing' && !!lastLifecycleAt) || scopedBusiness)
    ? `所选${conversationLabel(report.selected.id)}${scopedBusiness ? ' · 最近业务查询' : ''}` : '当前服务实例 · 全部会话';
  return <section className="fm-card dm-card" aria-label="模块地图">
    <header className="fm-section-head"><div><h2>模块地图</h2><p>点选模块查看观测依据和对应源码</p></div>
      <div className="dm-feedback-scope" role="group" aria-label="反馈观察范围">
        <button type="button" disabled={!report?.selected} aria-pressed={!shopFeedback && !!report?.selected}
          onClick={() => {setShopFeedback(false); setPicked(null);}}>本会话反馈</button>
        <button type="button" aria-pressed={shopFeedback || !report?.selected}
          onClick={() => {setShopFeedback(true); setPicked(null);}}>全店最近反馈</button>
        {!shopFeedback && !!earlierCases?.length && <select aria-label="本会话反馈案例" value={earlierCase?.caseId ?? ''}
          onChange={e => {setCaseId(e.target.value); setPicked(null);}}>
          <option value="">最近一次反馈</option>
          {earlierCases.map(c => <option key={c.caseId} value={c.caseId}>案例 {c.caseId.slice(-6).toUpperCase()}</option>)}
        </select>}
      </div>
    </header>
    <div className="dm-canvas"><div className="dm-map" role="group" aria-label="顾客消息经实时通信到达会话路由。查询本人订单经身份核验、订单查询、条款检索和资格判断。一般政策咨询直接查条款。会话路由也连接 AI 模型、坐席工作台和会话存储。店铺级资料管理向订单查询提供商品与订单，向条款检索提供已发布政策与已审核问答。坐席工作台标记转人工原因，运营根据反馈修订资料，经历史回放通过后发布到店铺资料库。">
      <Links selected={selected} /><Links narrow selected={selected} />
      {map.map(n => {const data = observation(n.id, report, feedbackChain);return <button type="button" key={n.id} data-module-node={n.id} aria-pressed={n.id === selected} className="dm-node" onClick={() => setPicked(n.id)}>
        <Icon name={n.icon} width="18" height="18" /><span><strong>{n.name}</strong><span className="fm-pill" data-tone={data.state}><i aria-hidden="true" />{n.id === 'merchant' ? '店铺级 · ' : ''}{data.status}</span></span>
      </button>;})}
    </div></div>
    <div className="dm-detail" aria-label="模块详情"><div><div className="dm-detail-title"><h3>{item.name}</h3><span>{scope}</span></div>
      {!currentBlockShown && <><p>{info.detail}</p>{info.at !== null && <small>观测时间 <time dateTime={new Date(info.at).toISOString()}>{new Date(info.at).toLocaleString('zh-CN',{hour12:false})}</time></small>}</>}
      {blocks && blocks.length > 0 && <ShopBlocks records={blocks} />}
      {selectedFeedback?.feedbackCaseId && <a className="md-text-button"
        href={'/merchant?case='+encodeURIComponent(selectedFeedback.feedbackCaseId)+'#feedback'}>查看本次修订的运营案例</a>}
      {report?.selected && <a className="link-button dm-trace-link" href={traceLink("TR-"+report.selected.id, report.selected.id)}>查看本会话流程日志</a>}
      {selected !== 'merchant' && report?.selected && <SessionEvidence node={selected} session={report.selected} />}</div>
      <div className="dm-files"><span>对应文件</span>{item.files.map(f => <code key={f}>{f}</code>)}</div>
    </div>
  </section>;
}
