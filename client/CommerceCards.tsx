import type { CommerceCard } from "../shared/commerce";
import { Icon } from "./ui";
import "./commerce.css";

function Evidence({ card }: { card: CommerceCard }) {
  return <>
    {card.facts.length > 0 && <dl className="commerce-facts">
      {card.facts.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>}
    {card.missing.length > 0 && <p className="commerce-missing"><strong>待核实</strong> {card.missing.join("、")}</p>}
    {card.sources.map(source => <details className="commerce-source" key={source.id + source.version}>
      <summary>查看条款原文 <span>{source.id} · {source.version}</span></summary>
      <strong>{source.title}</strong>
      <p>{source.text}</p>
    </details>)}
  </>;
}

const cardLabels = { order: "订单查询", return: "退货资格判断", faq: "店铺常见问题" };

export function CommerceResult({ card, onExplain }: { card: CommerceCard; onExplain?: () => void }) {
  return <article className="commerce-result" data-status={card.status} aria-label={cardLabels[card.kind]}>
    <header className="commerce-result-head"><span>{cardLabels[card.kind]}</span>{card.orderId && <small>{card.orderId}</small>}</header>
    <h3>{card.title}</h3>
    {card.selectedLine && <p className="commerce-deadline"><strong>本次退货商品</strong> 第 {card.selectedLine.line} 行 · {card.selectedLine.description} × {card.selectedLine.quantity} 件</p>}
    <p className="commerce-summary">{card.summary}</p>
    {card.deadline && <p className="commerce-deadline"><strong>申请截止</strong> {card.deadline}</p>}
    <Evidence card={card} />
    <p className="commerce-next">{card.nextStep}</p>
    <footer>模拟办理时间 · {card.asOf}（北京时间）{onExplain && <button className="link-button" type="button" onClick={onExplain}>解释这次判断</button>}</footer>
  </article>;
}

export function CommerceHandoff({ card, reason }: { card?: CommerceCard | null; reason?: string }) {
  if (!card) return reason ? <div className="commerce-transfer-reason"><strong>转接原因</strong> {reason}</div> : null;
  return <details className="commerce-handoff">
    <summary>
      <Icon name="headset" width="16" height="16" />
      <strong>人工交接</strong>
      <span className="handoff-title">{card.title}</span>
      <span className="handoff-toggle"><span className="when-closed">展开详情</span><span className="when-open">收起详情</span></span>
    </summary>
    <div className="commerce-handoff-body">
      <dl className="commerce-facts">
        <div><dt>顾客诉求</dt><dd>{card.request}</dd></div>
        {reason && <div><dt>转接原因</dt><dd>{reason}</dd></div>}
        {card.orderId && <div><dt>核验订单</dt><dd>{card.orderId}</dd></div>}
        <div><dt>判断依据</dt><dd>{card.summary}</dd></div>
        {card.reason && card.reason !== card.summary && <div><dt>判断说明</dt><dd>{card.reason}</dd></div>}
        {card.deadline && <div><dt>申请截止</dt><dd>{card.deadline}</dd></div>}
        <div><dt>核验时间</dt><dd>{card.asOf}（北京时间，模拟数据）</dd></div>
      </dl>
      <Evidence card={card} />
      <p className="commerce-next">{card.nextStep}</p>
    </div>
  </details>;
}
