import { useEffect, useState } from "react";
import { feedbackReasons, policyCheckLabels, type FeedbackCase, type FeedbackReplay } from "../shared/feedback";
import { caseLabels, expectationLabel, feedbackRequest, FeedbackRequestError } from "./feedback-api";
import { MerchantEditor } from "./MerchantEditor";
import { MerchantError } from "./MerchantDialog";
import { MerchantPublication, TrialComparison } from "./MerchantTrial";
import { errorMessage, rowKey, type Library, type MerchantRow } from "./merchant-library";
import { conversationLabel } from "./state";
import "./feedback.css";

const caseId = (id: string) => id.slice(-6).toUpperCase();
const dateTime = new Intl.DateTimeFormat("zh-CN", { timeZone:"Asia/Shanghai", dateStyle:"short", timeStyle:"short", hour12:false });

export function ReplayComparison({ report }: { report: FeedbackReplay }) {
  return <section className="fb-replay" aria-label="历史案例回放结果">
    <div className="fb-subhead"><h3>历史案例回放</h3><span className="md-badge" data-tone={report.passed ? "eligible" : "expired"}>{report.passed ? "全部通过" : "未通过"}</span></div>
    <p className="fb-meta">{dateTime.format(report.at)}（北京时间） · 历史案例 {report.rows.filter(row => row.passed).length} / {report.rows.length} 条符合预期
      {!!report.faqContrasts?.length && <> · 易混淆问法 {report.faqContrasts.filter(check=>check.passed).length} / {report.faqContrasts.length} 条已区分</>}</p>
    {report.issues.length > 0 && <MerchantError message={report.issues.join("\n")}/>}
    {report.rows.map(row => <article key={row.caseId} className="fb-replay-row">
      <div className="fb-subhead"><strong>{row.question}</strong><span className="md-badge" data-tone={row.passed ? "eligible" : "expired"}>{row.passed ? "通过" : "未通过"}</span></div>
      <dl className="fb-comparison">
        <div><dt>坐席预期</dt><dd>{row.expected}</dd></div>
        <div><dt>回放时的已发布版本</dt><dd>{row.before}</dd></div>
        <div><dt>本次修订</dt><dd>{row.after}</dd></div>
      </dl>{row.checks && <table className="fb-checks" aria-label="政策逐项核对"><thead><tr><th>核对项</th><th>坐席预期</th><th>修订结果</th></tr></thead>
        <tbody>{row.checks.map(check=><tr key={check.field} data-match={check.passed}><th scope="row">{policyCheckLabels[check.field]}</th><td>{check.expected}</td>
          <td>{check.actual} · {check.passed ? "符合" : "不符"}</td></tr>)}</tbody></table>}<p className="fb-meta">{row.detail}</p>
    </article>)}
    {!!report.faqContrasts?.length && <section aria-label="易混淆问法回放"><h3>易混淆问法</h3>{report.faqContrasts.map(check=>
      <article className="fb-replay-row" key={check.question}><div className="fb-subhead"><strong>{check.question}</strong>
        <span className="md-badge" data-tone={check.passed ? "eligible" : "expired"}>{check.passed ? "已区分" : "误匹配"}</span></div>
        <p>需排除 {check.excludedId} · 实际匹配 {check.actual}</p></article>)}</section>}
  </section>;
}

export function CaseDetail({ item, library, onUpdate, onPublished, onReload }: {
  item: FeedbackCase; library: Library | null; onUpdate: (next: FeedbackCase) => void; onPublished: () => void; onReload: () => void;
}) {
  const policy = item.expected.kind === "policy";
  const kind = policy ? "policies" : "faqs";
  const choices = (library?.data[kind] ?? []).filter(row => policy ? row["发布状态"] === "已发布" : row["状态"] === "已审核");
  const [baseKey, setBaseKey] = useState("");
  const [editing, setEditing] = useState<{row:MerchantRow; version:number} | null>(null);
  const [working, setWorking] = useState(""), [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showReceipt, setShowReceipt] = useState(false);
  const [staleProof, setStaleProof] = useState<number>();
  const editable = item.status !== "published" && item.expected.kind !== "none";
  const canPublish = item.status === "passed" && item.replay?.passed && item.version !== staleProof;

  function openEditor() {
    setError(""); setNotice("");
    if (item.draft) { setEditing({row:item.draft.row,version:item.version}); return; }
    const base = choices.find(row => rowKey(kind,row) === baseKey);
    const row: MerchantRow = { ...base, "版本":"" };
    if (policy) Object.assign(row, {"生效时间（含）":"","失效时间（不含）":"","发布状态":"草稿"});
    else Object.assign(row, { "问答编号":base?.["问答编号"] || "FAQ-" + caseId(item.id),
      "顾客常用问法":base?.["顾客常用问法"] || item.question, "状态":"草稿",
      "其他常见问法":base && base["顾客常用问法"] !== item.question ? [...new Set([...(base["其他常见问法"] || "").split("／"),item.question].filter(Boolean))].join("／") : base?.["其他常见问法"] || "",
    });
    setEditing({row,version:item.version});
  }
  async function mutate(action: "replay" | "publish") {
    setWorking(action); setError(""); setNotice("");
    try {
      const {item:next} = await feedbackRequest<{item:FeedbackCase}>("/" + encodeURIComponent(item.id) + "/" + action, {expectedVersion:item.version});
      onUpdate(next);
      if (action === "publish" && next.status === "published") { onPublished(); setNotice("修订已发布。顾客再次提问时会使用新版本。"); }
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof FeedbackRequestError && e.code === "stale") { setStaleProof(item.version); onReload(); }
    } finally { setWorking(""); }
  }
  return <section className="mt-panel fb-detail" aria-label="反馈详情">
    <div className="fb-eyebrow">案例 {caseId(item.id)}{item.draftVersion !== null && " · 修订 " + item.draftVersion} · {conversationLabel(item.conversationId)}</div>
    <a className="md-text-button" href={"/debug?conversation=" + encodeURIComponent(item.conversationId)} target="_blank" rel="noreferrer">查看此会话的模块地图</a>
    <div className="fb-subhead"><h2>{item.question || "仅标记本次转人工"}</h2><span className="md-badge" data-tone={item.status === "blocked" ? "expired" : item.status === "published" || item.status === "passed" ? "eligible" : "draft"}>{caseLabels[item.status]}</span></div>
    <dl className="fb-evidence">
      <div><dt>坐席标记</dt><dd>{feedbackReasons[item.reason]}</dd></div>
      {!!item.handoffReason && <div><dt>系统转接原因</dt><dd>{item.handoffReason}</dd></div>}
      {item.messageId && <div><dt>顾客当时收到</dt><dd>{item.originalAnswer || "当时未收到答复"}</dd></div>}
      <div><dt>坐席预期</dt><dd>{expectationLabel(item.expected)}</dd></div>
      {!!item.note && <div><dt>坐席备注</dt><dd>{item.note}</dd></div>}
      <div><dt>提交时间</dt><dd>{dateTime.format(item.createdAt)}（北京时间）</dd></div>
    </dl>
    {item.expected.kind !== "none" && <section className="fb-revision">
      <h3>{policy ? "退货政策" : "常见问答"}修订</h3>
      {item.draft ? <details className="md-sample"><summary>{item.draft.row[policy ? "条款编号" : "问答编号"]} · {item.draft.row["版本"]}<span>查看修订内容</span></summary>
        <dl className="md-values">{Object.entries(item.draft.row).filter(([label,value]) => value && label !== "状态" && label !== "发布状态").map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        {item.draft.orderIds?.length === 2 && <div><dt>试算订单</dt><dd>{item.draft.orderIds.join(" / ")}</dd></div>}</dl></details>
        : editable && <label className="md-field">修订依据<select value={baseKey} disabled={!library} onChange={e => setBaseKey(e.target.value)}>
          <option value="">{policy ? "新建政策" : "新增问答"}</option>{choices.map(row => <option key={rowKey(kind,row)} value={rowKey(kind,row)}>
            {row[policy ? "名称" : "顾客常用问法"]} · {row[policy ? "条款编号" : "问答编号"]} · {row["版本"]}</option>)}
        </select></label>}
      {editable && <div className="fb-case-actions">
        <button className={item.draft ? "secondary-button" : "primary-button"} type="button" disabled={!library || !!working} onClick={openEditor}>{item.draft ? "编辑修订草稿" : !policy && baseKey ? "将顾客原话加入这条问答" : "创建修订草稿"}</button>
        {item.draft && <button className={item.status === "passed" ? "secondary-button" : "primary-button"} disabled={!!working} type="button" onClick={() => void mutate("replay")}>{working === "replay" ? "正在回放…" : "运行历史回放"}</button>}
      </div>}
    </section>}
    {item.replay && <ReplayComparison report={item.replay}/>}
    {item.replay?.orderTrial ? <details className="md-sample fb-order-trial">
      <summary>两笔订单的试算结果</summary><TrialComparison report={item.replay.orderTrial} archived={item.status === "published"}/>
    </details> : policy && item.status === "published" && item.draft && <button className="md-text-button" type="button" onClick={() => setShowReceipt(true)}>查看发布时的两单试算记录</button>}
    {showReceipt && item.draft && <MerchantPublication policy={item.draft.row} onClose={() => setShowReceipt(false)}/>}
    {editable && item.draft && <div className="fb-publish"><p>{canPublish ? "本次修订的历史案例回放已通过。" : "历史案例回放全部通过后可发布。"}</p>
      <button className="primary-button" type="button" disabled={!!working || !canPublish} onClick={() => void mutate("publish")}>{working === "publish" ? "发布中…" : "发布修订"}</button></div>}
    {notice && <p role="status" className="mt-success">{notice}</p>}
    {item.publishedAt && <p className="fb-meta">发布时间 · {dateTime.format(item.publishedAt)}（北京时间）</p>}
    <MerchantError message={error}/>
    {editing && library && <MerchantEditor library={library} kind={kind} mode="new" source={editing.row} onClose={() => setEditing(null)} onSaved={text => {setEditing(null);setNotice(text);}}
      revision={{question:item.question, orderIds:item.draft?.orderIds, contrastQuestions:item.draft?.contrastQuestions, save:async (row,orderIds,contrastQuestions) => {
        const {item:next} = await feedbackRequest<{item:FeedbackCase}>("/" + encodeURIComponent(item.id) + "/draft",
          {kind:policy ? "policy" : "faq",row, orderIds, contrastQuestions, expectedVersion:editing.version});
        onUpdate(next);
      }}}/>}
  </section>;
}

export function MerchantFeedback({ library, onPublished }: { library: Library | null; onPublished: () => void }) {
  const [cases, setCases] = useState<FeedbackCase[]>([]), [selected, setSelected] = useState(()=>
    typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("case") ?? "");
  const [error, setError] = useState(""), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true); setError("");
    feedbackRequest<{cases:FeedbackCase[]}>("").then(result => { if (current) setCases(result.cases); })
      .catch(e => { if (current) setError(errorMessage(e)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [revision]);
  const active = cases.find(item => item.id === selected) ?? cases[0];
  return <><div className="mt-section-head"><div><h1>坐席反馈</h1><p>按顾客原话修订问答或退货政策，用坐席标注的正确结果核对历史案例。</p></div>
    <button className="secondary-button" disabled={loading} onClick={() => setRevision(value => value + 1)}>刷新反馈</button></div>
    <MerchantError message={error}/>{error.includes("坐席工作台登录") && <a href="/agent" className="md-text-button">进入坐席工作台</a>}
    {cases.length > 0 ? <div className="fb-workspace"><nav aria-label="反馈案例" className="mt-panel fb-inbox">
      <h2>历史案例 <span>{cases.length}</span></h2>
      {cases.map(item => <button className="fb-case-link" key={item.id} type="button" aria-current={item.id === active.id ? "true" : undefined} onClick={() => setSelected(item.id)}>
        <small>{caseId(item.id)} · {feedbackReasons[item.reason]}</small><strong>{item.question || "仅标记本次转人工"}</strong><span>{caseLabels[item.status]}</span></button>)}</nav>
      <CaseDetail key={active.id} item={active} library={library} onPublished={onPublished} onReload={() => setRevision(value => value + 1)}
        onUpdate={next => setCases(previous => previous.map(entry => entry.id === next.id ? next : entry))}/>
    </div> : !error && <div className="mt-panel mt-empty"><strong>{loading ? "正在读取坐席反馈…" : "暂无坐席反馈"}</strong>{!loading && <p>在坐席工作台接待会话后，可标记转人工原因。</p>}</div>}
  </>;
}
