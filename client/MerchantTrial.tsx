import { useEffect, useState } from "react";
import { MerchantDialog, MerchantError } from "./MerchantDialog";
import { errorMessage, merchantRequest, policyKeyOf, type Decision, type MerchantRow, type Trial, type TrialReport } from "./merchant-library";

function DecisionView({ label, decision }: { label: string; decision: Decision }) {
  const labels: Record<string, string> = { eligible: "在退货期限内", expired: "已超过期限", review: "需人工核对" };
  return <div className="md-decision"><small>{label}</small><div><strong>{decision.version || "未命中"}</strong>
    <span className="md-badge" data-tone={decision.status}>{labels[decision.status] || decision.status}</span></div>
    {decision.deadline && <p>截止 {decision.deadline}</p>}<p>{decision.reason}</p></div>;
}

export function TrialComparison({ report, archived = false }: { report: TrialReport; archived?: boolean }) {
  return <section className="md-preview" aria-label={archived ? "发布时的试算结果" : "政策试算结果"}>
    <h3>{archived ? "发布时的试算结果" : "试算结果"}</h3><p className="md-hint">模拟判断时间　{report.asOf}（北京时间）</p>
    {!!report.issues?.length && <MerchantError message={report.issues.join("\n")} />}
    {report.results.map(result => <article className="md-trial-order" key={result.orderId}>
      <header><strong>{result.orderId}</strong><span>{result.changed ? "判断有变化" : "判断一致"}</span></header>
      <div className="md-compare"><DecisionView label={archived ? "发布前" : "试算时的已发布版本"} decision={result.before} /><DecisionView label={archived ? "发布后" : "拟发布版本"} decision={result.after} /></div>
    </article>)}
  </section>;
}

export function MerchantPublication({ policy, onClose }: {policy: MerchantRow; onClose: () => void}) {
  const [report, setReport] = useState<TrialReport | null>(null), [error, setError] = useState("");
  const key = policyKeyOf(policy);
  useEffect(() => {
    let active = true;
    setError(""); setReport(null);
    merchantRequest<TrialReport>("/publication?policyKey=" + encodeURIComponent(key))
      .then(value => { if (active) setReport(value); })
      .catch(reason => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [key]);
  return <MerchantDialog title="发布试算记录" onClose={onClose}><div className="md-body">
    <div className="md-policy-summary"><span className="md-badge" data-tone="eligible">已发布</span>
      <strong>{policy["名称"]}</strong><p>{policy["条款编号"]} · {policy["版本"]}　生效于 {policy["生效时间（含）"]}</p></div>
    {report ? <TrialComparison report={report} archived /> : error ? <MerchantError message={error} /> : <p role="status">正在读取发布记录…</p>}
  </div><footer className="md-footer"><button type="button" className="secondary-button" onClick={onClose}>关闭</button></footer></MerchantDialog>;
}

export function policySamples(policy: MerchantRow, orders: MerchantRow[], policies: MerchantRow[]) {
  const match = orders.filter(order => order["店铺"] === policy["适用店铺"] && order["成交渠道"] === policy["渠道"] && order["成交活动"] === policy["活动"]);
  const choices = [...new Map(match.map(row => [row["订单号"], row])).values()]
    .sort((a, b) => a["下单时间"].localeCompare(b["下单时间"]));
  const olderPolicy = policies.some(p => p["条款编号"] === policy["条款编号"] && p["发布状态"] === "已发布" && p["生效时间（含）"] < policy["生效时间（含）"] && ["适用店铺","渠道","活动"].every(field => p[field] === policy[field]));
  const olderOrder = choices.filter(o => o["下单时间"] < policy["生效时间（含）"]).at(-1) ?? (olderPolicy ? undefined : choices[0]);
  const newerOrder = choices.find(o => o["下单时间"] !== olderOrder?.["下单时间"] && o["下单时间"] >= policy["生效时间（含）"] && (!policy["失效时间（不含）"] || o["下单时间"] < policy["失效时间（不含）"]));
  return {choices, olderPolicy, oldId:olderOrder?.["订单号"] || "", newId:newerOrder?.["订单号"] || ""};
}

export function MerchantTrial({ policy, orders, policies, onClose, onSaved }: {
  policy: MerchantRow; orders: MerchantRow[]; policies: MerchantRow[]; onClose: () => void; onSaved: (message: string) => void;
}) {
  const samples = policySamples(policy, orders, policies);
  const {choices, olderPolicy} = samples;
  const [oldId, setOldId] = useState(samples.oldId);
  const [newId, setNewId] = useState(samples.newId);
  const [trial, setTrial] = useState<Trial | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const policyKey = policyKeyOf(policy);
  async function run(publish: boolean) {
    setBusy(true); setError("");
    try {
      const result = await merchantRequest<Trial>(publish ? "/publish" : "/trial", { policyKey, orderIds: [oldId, newId], ...(publish ? { token: trial!.token } : {}) });
      if (publish) onSaved(`政策 ${policy["条款编号"]} · ${policy["版本"]} 已发布。`);
      else setTrial(result);
    } catch (e) { setError(errorMessage(e)); setTrial(null); } finally { setBusy(false); }
  }
  return <MerchantDialog title="政策试算与发布" onClose={onClose} busy={busy}>
    <div className="md-body">
      <div className="md-policy-summary"><span className="md-badge" data-tone="draft">草稿</span><strong>{policy["名称"]}</strong>
        <p>{policy["条款编号"]} · {policy["版本"]}　生效于 {policy["生效时间（含）"]}</p>
        <details><summary>查看待发布条款原文</summary><p>{policy["条款原文"]}</p></details>
      </div>
      <p className="md-hint">{olderPolicy ? "选择生效前后的两笔订单，对照发布前后的版本、期限和判断理由。" : "选择适用范围内下单时间不同的两笔订单。首版政策可使用两笔生效后的订单。"}{choices.length < 2 && " 当前范围不足两笔订单，请先在已售订单中补录样本。"}</p>
      <div className="md-grid">{(["旧订单", "新订单"] as const).map((label, i) =>
        <label className="md-field" key={label}>{label}
          <select value={i === 0 ? oldId : newId} disabled={busy} onChange={e => {
            (i === 0 ? setOldId : setNewId)(e.target.value); setTrial(null); setError("");
          }}>
            <option value="">选择{label}</option>{choices.map(row => <option key={row["订单号"]} value={row["订单号"]}>
              {row["订单号"]} · {row["下单时间"]} · {row["成交活动"]}</option>)}
          </select>
        </label>)}
      </div>
      {oldId && oldId === newId && <p className="md-hint">请为新旧订单选择不同的订单号。</p>}
      {trial && <TrialComparison report={trial} />}
      <MerchantError message={error} />
    </div>
    <footer className="md-footer"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>关闭</button>
      <button type="button" className={trial ? "secondary-button" : "primary-button"} disabled={busy || !oldId || !newId || oldId === newId} onClick={() => run(false)}>运行试算</button>
      {trial && <button type="button" className="primary-button" disabled={busy || !!trial.issues?.length} onClick={() => run(true)}>确认发布此版本</button>}
    </footer>
  </MerchantDialog>;
}
