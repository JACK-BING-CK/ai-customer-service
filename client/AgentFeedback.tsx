import { useEffect, useState, type FormEvent } from "react";
import { feedbackReasons, type FeedbackCase, type FeedbackExpected, type FeedbackInput, type FeedbackReason } from "../shared/feedback";
import type { Message, Snapshot } from "../shared/protocol";
import { MerchantDialog, MerchantError } from "./MerchantDialog";
import { caseLabels, decisionLabels, expectationLabel, feedbackRequest } from "./feedback-api";
import { errorMessage } from "./merchant-library";
import "./merchant.css";
import "./feedback.css";

export function AgentFeedbackForm({ snapshot, cases, busy, onSubmit }: {
  snapshot: Snapshot; cases: FeedbackCase[]; busy: boolean; onSubmit: (input: FeedbackInput) => Promise<void>;
}) {
  const questions = snapshot.messages.flatMap((message, index) => {
    if (message.role !== "customer" || cases.some(item => item.messageId === message.id)) return [];
    const next = snapshot.messages[index + 1];
    return [{message, reply:next?.role === "assistant" ? next : undefined}];
  }).toReversed();
  const initial = questions.find(q => q.reply) ?? questions[0];
  function suggested(reply?: Message, direct = false): {reason:FeedbackReason; kind:FeedbackExpected["kind"]} {
    if (direct) return {reason:"customer_request",kind:"none"};
    const card = reply?.commerceCard;
    if (card?.kind === "return" && card.orderId && Object.hasOwn(decisionLabels,card.status)) return {reason:"policy_issue",kind:"policy"};
    if (card && card.kind !== "faq") return {reason:"missing_facts",kind:"none"};
    return {reason:card?.status === "found" ? "faq_wrong" : "faq_gap",kind:"faq"};
  }
  const defaults = suggested(initial?.reply, !initial);
  const [messageId, setMessageId] = useState(() => initial?.message.id ?? "");
  const [reason, setReason] = useState<FeedbackReason>(defaults.reason);
  const [kind, setKind] = useState<FeedbackExpected["kind"]>(defaults.kind);
  const [answer, setAnswer] = useState(""), [note, setNote] = useState("");
  const [status, setStatus] = useState<keyof typeof decisionLabels>("eligible");
  const [versions, setVersions] = useState(""), [noVersions, setNoVersions] = useState(false);
  const [deadline, setDeadline] = useState(""), [noDeadline, setNoDeadline] = useState(false);
  const reply = questions.find(q => q.message.id === messageId)?.reply;
  const allowFaq = !!messageId && (!reply?.commerceCard || reply.commerceCard.kind === "faq");
  const allowPolicy = reply?.commerceCard?.kind === "return" && !!reply.commerceCard.orderId && Object.hasOwn(decisionLabels,reply.commerceCard.status);
  function changeReason(next: FeedbackReason) {
    setReason(next);
    setKind(next === "policy_issue" && allowPolicy ? "policy" : (next === "faq_wrong" || next === "faq_gap") && allowFaq ? "faq" : "none");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const expected: FeedbackExpected = kind === "faq" ? {kind, answer:answer.trim()} : kind === "policy" ? {
      kind, status, versions:noVersions ? [] : versions.trim().split(/\s+/u),
      deadline:noDeadline ? null : deadline.replace("T", " ") + (deadline.length === 16 ? ":00" : ""),
    } : {kind};
    await onSubmit({messageId, reason, note:note.trim(), expected});
  }
  return <form className="fb-agent-form" onSubmit={submit}>
    {snapshot.handoffReason && <p className="md-hint">系统记录的转接原因 · {snapshot.handoffReason}</p>}
    <div className="md-grid">
      <label className="md-field md-wide">顾客原话<select value={messageId} disabled={busy} onChange={e => {
        const next = suggested(questions.find(q => q.message.id === e.target.value)?.reply,!e.target.value);
        setMessageId(e.target.value); setReason(next.reason); setKind(next.kind); setAnswer(""); setNote("");
        setStatus("eligible"); setVersions(""); setNoVersions(false); setDeadline(""); setNoDeadline(false);
      }}>
        {questions.map(({message}) => <option key={message.id} value={message.id}>{message.text}</option>)}
        <option value="">仅标记本次转人工</option>
      </select></label>
      {messageId && <div className="fb-original md-wide"><small>顾客当时收到</small><p>{reply?.text || "该问题未取得系统答复"}</p></div>}
      <label className="md-field">转人工原因<select value={reason} disabled={busy} onChange={e => changeReason(e.target.value as FeedbackReason)}>
        {Object.entries(feedbackReasons).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label className="md-field">回放预期<select value={kind} disabled={busy || !messageId} onChange={e => setKind(e.target.value as FeedbackExpected["kind"])}>
        <option value="faq" disabled={!allowFaq}>核对问答</option><option value="policy" disabled={!allowPolicy}>核对退货政策</option><option value="none">仅记录原因</option>
      </select></label>
      {kind === "faq" && <label className="md-field md-wide">正确答复<textarea value={answer} maxLength={8000} disabled={busy} required rows={3}
        onChange={e => setAnswer(e.target.value)} placeholder="填写顾客应该收到的标准答复，供运营回放核对。" /></label>}
      {kind === "policy" && <><label className="md-field md-wide">正确的退货判断<select value={status} disabled={busy} onChange={e => setStatus(e.target.value as keyof typeof decisionLabels)}>
        {Object.entries(decisionLabels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
        <div className="md-field"><label>预期条款版本<textarea value={versions} required={!noVersions} disabled={busy || noVersions}
          rows={2} maxLength={6500} placeholder="条款编号@版本，每行一条" onChange={e=>setVersions(e.target.value)}/></label>
          <label className="fb-check-option"><input type="checkbox" checked={noVersions} disabled={busy} onChange={e=>setNoVersions(e.target.checked)}/>无适用版本</label>
          {!!reply?.commerceCard?.sources.length && <small>原卡引用 {reply.commerceCard.sources.map(s=>s.id+"@"+s.version).join("、")}</small>}
        </div>
        <div className="md-field"><label>预期截止时间（北京时间）<input type="datetime-local" step="1" value={deadline}
          required={!noDeadline} disabled={busy || noDeadline} onChange={e=>setDeadline(e.target.value)}/></label>
          <label className="fb-check-option"><input type="checkbox" checked={noDeadline} disabled={busy} onChange={e=>setNoDeadline(e.target.checked)}/>无截止时间</label>
          {reply?.commerceCard?.deadline && <small>原卡截止 {reply.commerceCard.deadline}</small>}
        </div>
      </>}
      <label className="md-field md-wide">给运营的备注（选填）<textarea value={note} maxLength={2000} disabled={busy} rows={2} onChange={e => setNote(e.target.value)} /></label>
    </div>
    <div className="fb-case-actions"><button className="primary-button" disabled={busy || (kind === "faq" && !answer.trim()) || cases.some(item => item.messageId === messageId)}>{busy ? "提交中…" : "提交反馈"}</button></div>
  </form>;
}

export function AgentFeedback({ snapshot, token, onClose }: { snapshot: Snapshot; token: string; onClose: () => void }) {
  const [cases, setCases] = useState<FeedbackCase[] | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    feedbackRequest<{cases:FeedbackCase[]}>("?conversationId=" + encodeURIComponent(snapshot.id), undefined, token)
      .then(result => { if (active) { setCases(result.cases); setError(""); } })
      .catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, [snapshot.id, token, refresh]);
  async function capture(input: FeedbackInput) {
    setBusy(true); setError("");
    try {
      const {item} = await feedbackRequest<{item:FeedbackCase}>("/capture", {conversationId:snapshot.id,...input}, token);
      setCases(previous => [item, ...(previous ?? []).filter(entry => entry.id !== item.id)]); setSaved(true);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <MerchantDialog title="标记转人工原因" busy={busy} onClose={onClose}><div className="md-body">
    {saved && <p className="mt-success" role="status">反馈已提交。运营可在店铺资料管理的「坐席反馈」查看。</p>}
    {!!cases?.length && <section className="fb-records" aria-label="本会话已标记的反馈"><h3>本会话反馈</h3>{cases.map(item => <div className="fb-record" key={item.id}>
      <strong>{feedbackReasons[item.reason]}</strong> <span className="md-badge">{caseLabels[item.status]}</span>
      <p>{item.question || "仅标记本次转人工"}</p>{item.expected.kind !== "none" && <p>预期 · {expectationLabel(item.expected)}</p>}
    </div>)}</section>}
    {!saved && cases && <AgentFeedbackForm snapshot={snapshot} cases={cases} busy={busy} onSubmit={capture}/>}
    {!cases && !error && <p className="md-hint" role="status">正在读取本会话反馈…</p>}
    <MerchantError message={error}/>
    {!cases && error && <button type="button" className="md-text-button" onClick={() => setRefresh(value => value + 1)}>重新读取</button>}
  </div><footer className="md-footer"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>关闭</button></footer></MerchantDialog>;
}
