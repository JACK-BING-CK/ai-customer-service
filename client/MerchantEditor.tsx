import { useId, useState, type FormEvent } from "react";
import { MerchantDialog, MerchantError } from "./MerchantDialog";
import { policySamples } from "./MerchantTrial";
import { merchantKeyFields } from "../shared/merchant";
import { catalog, errorMessage, merchantRequest, type Library, type MerchantKind, type MerchantRow, type WriteResult } from "./merchant-library";

const policyDefaults = {
  "按何时选版本": "下单时间", "期限起算点": "签收次日算第 1 天",
  "计时口径": "日历日／北京时间／含截止日", "发布状态": "草稿",
};
const optionalFields = new Set(["签收时间", "失效时间（不含）", "其他常见问法"]);
const dates = new Set(["下单时间", "签收时间", "物流更新时间", "生效时间（含）", "失效时间（不含）"]);
const numeric = new Set(["行号", "天数", "购买数量"]);
const long = new Set(["已确认的商品事实", "条款原文", "其他常见问法", "标准答复"]);
const hints: Record<string, string> = {
  "商品编码（SKU）": "如 CUP-500-G", "订单号": "如 DEMO-3101", "其他常见问法": "多种问法可以用「／」分隔",
  "失效时间（不含）": "持续有效时留空", "签收时间": "未签收时留空", "条款编号": "同一政策的不同版本沿用同一编号",
  "活动": "如秋季活动或日常销售", "成交活动": "如秋季活动或日常销售",
};

export function MerchantEditor({ library, kind, source, mode, onClose, onSaved, revision }: {
  library: Library; kind: MerchantKind; source?: MerchantRow; mode: "new" | "edit" | "copy" | "view";
  onClose: () => void; onSaved: (message: string) => void;
  revision?: { question: string; orderIds?: string[]; contrastQuestions?: string[]; save: (row: MerchantRow, orderIds?: string[], contrastQuestions?: string[]) => Promise<void> };
}) {
  const [row, setRow] = useState<MerchantRow>(() => {
    const initial: MerchantRow = { ...(kind === "orders" ? { "行号": "1", "购买数量": "1", "店铺会员编号": "A" }
      : kind === "policies" ? policyDefaults : kind === "faqs" ? { "状态": "草稿" } : {}), ...source };
    if (mode === "copy") Object.assign(initial, kind === "policies"
      ? { "版本": "", "生效时间（含）": "", "失效时间（不含）": "", "发布状态": "草稿" }
      : { "版本": "", "状态": "草稿" });
    return initial;
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [chosenOrders, setChosenOrders] = useState(revision?.orderIds);
  const [contrastText, setContrastText] = useState(revision?.contrastQuestions?.join("\n") ?? "");
  const samples = revision && kind === "policies" ? policySamples(row, library.data.orders, library.data.policies) : null;
  const orderIds = samples ? chosenOrders ?? [samples.oldId, samples.newId] : undefined;
  const id = useId();
  const view = mode === "view";
  const change = (key: string, value: string) => {
    if (["条款编号","适用店铺","渠道","活动","生效时间（含）","失效时间（不含）"].includes(key)) setChosenOrders(undefined);
    setRow(current => ({ ...current, [key]: value }));
  };
  const title = revision ? (kind === "faqs" ? "修订常见问答" : "修订退货政策") : mode === "new" ? catalog[kind].add : mode === "copy" ? (kind === "faqs" ? "新建问答版本" : "新建政策版本") : (view ? "查看" : "编辑") + catalog[kind].name;
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (revision) {
        const examples = kind === "faqs" ? contrastText.split(/\r?\n/).map(q=>q.trim()).filter(Boolean) : undefined;
        await revision.save(row,orderIds,examples);
        onSaved("已保存修订草稿。"); return;
      }
      const result = await merchantRequest<WriteResult>("/save", { kind, row, ...(mode === "edit" ? { original: source } : {}) });
      if (!result.ok) throw new Error(result.errors.join("\n"));
      onSaved(result.changes === 0 ? "资料已核对，内容无变化。" : kind === "policies" ? "政策草稿已保存，可选择新旧订单试算。" : catalog[kind].name + "已保存。");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  function generateClause() {
    change("条款原文", `本条适用于${row["适用店铺"]}在${row["渠道"]}售出的${row["活动"]}商品。按下单时间选用规则版本。从签收次日起计第 1 天，共 ${row["天数"]} 个日历日。可在最后一天北京时间 23:59:59 前（含该秒）提出退货申请。`);
  }
  return <MerchantDialog title={title} busy={busy} onClose={onClose}>
    <form onSubmit={save}>
      <div className="md-body">
        {revision && <p className="md-policy-summary">本次反馈 · {revision.question}</p>}
        {kind === "orders" || kind === "policies" ? <p className="md-hint">所有日期和时间均按北京时间填写。</p> : null}
        {mode === "copy" && <p className="md-hint">已从 {source?.["版本"]} 复制。{kind === "faqs" ? "填写新版本并核对答复。设为已审核后将替换同编号的现行答复。" : "填写新版本和生效时间，再核对条款原文。"}</p>}
        {kind === "orders" && mode === "edit" && <p className="md-hint">{source?.["成交商品编码"] ? "成交资料已留档，可补录新的物流状态和时间。" : "历史订单可补录成交商品编码及规格，已有的会员、成交和物流事实已保留。"}</p>}
        <div className="md-grid">
          {library.fields[kind].map(field => {
            const value = row[field] || "";
            const historical = kind === "orders" && mode === "edit" && (source?.["成交商品编码"]
              ? !["物流状态", "物流更新时间", ...(source["签收时间"] ? [] : ["签收时间"])].includes(field)
              : !["成交商品编码", "成交商品与规格", "购买数量"].includes(field));
            const fixed = view || !!historical || (mode === "edit" && merchantKeyFields[kind].includes(field)) || (kind === "policies" && field in policyDefaults) || (!!revision && field === "状态");
            const options = field === "店铺会员编号" ? ["A", "B"] : kind === "faqs" && field === "状态" ? ["草稿", "已审核", ...(value === "示例草稿" ? [value] : [])] : null;
            const suggestions = field === "成交商品编码" ? library.data.products.map(product => product["商品编码（SKU）"])
              : field === "物流状态" ? ["待发货", "运输中", "已签收"] : [];
            const inputId = id + "-" + field;
            const common = { id: inputId, value, disabled: busy, required: !fixed && !optionalFields.has(field), placeholder: hints[field] };
            return <div key={field} className={"md-field" + (long.has(field) ? " md-wide" : "")}>
              <div className="md-field-head"><label htmlFor={inputId}>{field}</label>
                {field === "条款原文" && !view && <button type="button" className="md-text-button" disabled={busy || !["适用店铺", "渠道", "活动", "天数"].every(key => row[key]?.trim())}
                  onClick={generateClause}>按字段生成期限条款</button>}
              </div>
              {long.has(field) ? <textarea {...common} readOnly={fixed} rows={field === "条款原文" ? 4 : 2} onChange={e => change(field, e.target.value)} />
                : options && !fixed ? <select {...common} onChange={e => change(field, e.target.value)}>{options.map(v => <option key={v}>{v}</option>)}</select>
                : <input {...common} type={dates.has(field) ? "datetime-local" : numeric.has(field) ? "number" : "text"} list={suggestions.length ? inputId + "-options" : undefined}
                  step={dates.has(field) || numeric.has(field) ? 1 : undefined} min={numeric.has(field) ? 1 : undefined}
                  value={dates.has(field) ? value.replace(" ", "T") : value} readOnly={fixed}
                  onChange={e => { let next = e.target.value; if (dates.has(field)) { next = next.replace("T", " "); if (next.length === 16) next += ":00"; } change(field, next); }} />}
              {suggestions.length > 0 && <datalist id={inputId + "-options"}>{suggestions.map(v => <option key={v} value={v} />)}</datalist>}
              {(field === "签收时间" || field === "失效时间（不含）") && !view && <small>{hints[field]}</small>}
              {field === "条款原文" && !view && <small>如另有拆封、使用状态等条件，系统会列出期限并交由人工核对原文。</small>}
            </div>;
          })}
        </div>
        {revision && kind === "faqs" && <label className="md-field">易混淆问法（每行一句）
          <textarea rows={2} value={contrastText} onChange={e=>setContrastText(e.target.value)} disabled={busy}
            placeholder="例如补寄配件问答要区分：整个杯子退货谁付邮费？"/>
          <small>填写应由其他条款回答的问题。回放发现本问答误匹配时，会拦住发布。</small>
        </label>}
        {samples && orderIds && <section className="md-preview"><h3>政策试算订单</h3>
          <p className="md-hint">选择适用店铺、渠道和活动内的两笔订单。已有旧版时，请用生效时间前后各一笔订单。</p>
          <div className="md-grid">{["旧订单","新订单"].map((label,index) => <label className="md-field" key={label}>{label}
            <select value={orderIds[index]} required disabled={busy} onChange={e => setChosenOrders(orderIds.map((id,i) => i === index ? e.target.value : id))}>
              <option value="">选择{label}</option>{samples.choices.map(order => <option key={order["订单号"]} value={order["订单号"]}>{order["订单号"]} · {order["下单时间"]}</option>)}
            </select></label>)}</div>
          {samples.choices.length < 2 && <p className="md-hint">当前范围不足两笔订单，请核对适用范围或补录订单。</p>}
        </section>}
        <MerchantError message={error} />
      </div>
      <footer className="md-footer"><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>{view ? "关闭" : "取消"}</button>
        {!view && <button className="primary-button" disabled={busy || (!!orderIds && (!orderIds.every(Boolean) || orderIds[0] === orderIds[1]))}>{busy ? "保存中…" : revision ? "保存修订草稿" : kind === "policies" ? "保存草稿" : "保存资料"}</button>}
      </footer>
    </form>
  </MerchantDialog>;
}
