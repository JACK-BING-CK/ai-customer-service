import { useEffect, useState } from "react";
import { HubLink, Icon } from "./ui";
import { MerchantError } from "./MerchantDialog";
import { MerchantEditor } from "./MerchantEditor";
import { MerchantImport } from "./MerchantImport";
import { MerchantPublication, MerchantTrial } from "./MerchantTrial";
import { MerchantFeedback } from "./MerchantFeedback";
import { catalog, errorMessage, merchantRequest, policyKeyOf, published, rowKey, sections, type Library, type MerchantKind, type MerchantRow } from "./merchant-library";
import "./merchant.css";

type Action = { type: "new" | "import" } | { type: "edit" | "copy" | "view" | "trial" | "publication"; row: MerchantRow };
const drawings = {
  products: <><path d="m4 7 8-4 8 4v10l-8 4-8-4Z"/><path d="m4 7 8 4 8-4m-8 4v10m-4-16 8 4"/></>,
  orders: <><path d="M6 3h12v17l-3-1.6-3 1.6-3-1.6L6 20Z"/><path d="M9 8h6m-6 4h6"/></>,
  policies: <><path d="M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4Z"/><path d="M5 17a2 2 0 0 1 2-2h12m-8-11v6l2-1.3 2 1.3V4"/></>,
  faqs: <><path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M7 8h10M7 12h7"/></>,
  shop: <><path d="M4 10v10h16V10m-17-1 2-5h14l2 5a3 3 0 0 1-4.5 2A3 3 0 0 1 12 11a3 3 0 0 1-4.5 0A3 3 0 0 1 3 9Zm6 11v-6h6v6"/></>,
  import: <><path d="M12 15V3m-5 5 5-5 5 5M4 15v5h16v-5"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  plus: <path d="M12 5v14m-7-7h14"/>,
};
function Mark({ name }: {name: keyof typeof drawings}) {
  return <svg width="19" height="19" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">{drawings[name]}</svg>;
}
function sectionFromHash(): MerchantKind | "feedback" {
  if (window.location.hash === "#feedback") return "feedback";
  return sections.find(item => item === window.location.hash.slice(1)) || "products";
}
export function Merchant() {
  const [library, setLibrary] = useState<Library | null>(null);
  const [tab, setTab] = useState(sectionFromHash), [action, setAction] = useState<Action | null>(null);
  const kind = tab === "feedback" ? "products" : tab;
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [search, setSearch] = useState(""), [page, setPage] = useState(1);
  async function reload() {
    setLoading(true); setError("");
    try { setLibrary(await merchantRequest<Library>()); } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }
  useEffect(() => { void reload(); }, []);
  useEffect(() => {
    const navigate = () => { setTab(sectionFromHash()); setAction(null); setSearch(""); setPage(1); setMessage(""); };
    window.addEventListener("hashchange", navigate); return () => window.removeEventListener("hashchange", navigate);
  }, []);
  const section = catalog[kind], all = library?.data[kind] || [];
  const publications = new Set(library?.publications);
  const needle = search.trim().toLocaleLowerCase();
  const rows = needle ? all.filter(row => Object.values(row).some(value => value.toLocaleLowerCase().includes(needle))) : all;
  const pages = Math.max(1, Math.ceil(rows.length / 20)), activePage = Math.min(page, pages);
  const visible = rows.slice((activePage - 1) * 20, activePage * 20);
  function saved(text: string) { setAction(null); setMessage(text); void reload(); }
  const close = () => setAction(null);
  return <div className="merchant">
    <header className="mt-header"><div className="mt-head-inner"><a href="/merchant" className="mt-brand">
      <span className="mt-brand-mark"><Mark name="shop" /></span><span>店铺资料管理</span></a>
      <div className="mt-head-actions"><a className="mt-template" href="/api/merchant/template" download>下载 Excel 模板</a>
        <button type="button" className="secondary-button" disabled={!library || loading} onClick={() => setAction({ type: "import" })}><Mark name="import" />导入 Excel</button>
      </div></div></header>
    <div className="mt-layout"><aside className="mt-sidebar"><nav aria-label="店铺资料目录">
      {sections.map(key => <a key={key} href={"#" + key} aria-current={key === tab ? "page" : undefined}>
        <Mark name={key} /><span>{catalog[key].name}</span>{library && <small>{library.data[key].length}</small>}
      </a>)}<a href="#feedback" aria-current={tab === "feedback" ? "page" : undefined}><Icon name="headset" width="19" height="19"/><span>坐席反馈</span></a>
      <HubLink /></nav></aside>
      <main className="mt-main">{tab === "feedback" ? <>
        {error && <div className="mt-fetch-error"><MerchantError message={error} /><button type="button" className="secondary-button" onClick={reload}>重新加载店铺资料</button></div>}
        <MerchantFeedback library={library} onPublished={reload}/>
      </> : <><div className="mt-section-head"><div><h1>{section.name}</h1><p>{section.description}</p></div>
        <button className="primary-button" type="button" disabled={!library || loading} onClick={() => setAction({ type: "new" })}><Mark name="plus" />{section.add}</button>
      </div>
      {message && <div className="mt-success" role="status"><Icon name="check" width="17" height="17" />{message}<button type="button" onClick={() => setMessage("")} aria-label="关闭提示">×</button></div>}
      {error && <div className="mt-fetch-error"><MerchantError message={error} /><button type="button" className="secondary-button" onClick={reload}>重新加载</button></div>}
      <section className="mt-panel" aria-label={section.name + "列表"} aria-busy={loading}>
        <div className="mt-tools"><strong>{loading && !library ? "正在读取…" : search ? `找到 ${rows.length} ${section.unit}` : `共 ${all.length} ${section.unit}`}</strong>
          <label className="mt-search"><Mark name="search" /><input aria-label={"搜索" + section.name} placeholder={"搜索" + section.name} type="search" value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }} /></label></div>
        {visible.length ? <div className="mt-scroll"><table><thead><tr>{section.columns.map(col => <th key={col} scope="col">{col}</th>)}<th scope="col">操作</th></tr></thead>
          <tbody>{visible.map(row => <tr key={rowKey(kind, row)}>{section.columns.map((col, i) => <td key={col} className={i === 0 ? "mt-first-cell" : undefined}>
            {col === "状态" || col === "发布状态" ? <span className="md-badge" data-tone={["已审核", "已发布"].includes(row[col]) ? "eligible" : "draft"}>{row[col]}</span>
            : row[col] || "—"}</td>)}<td className="mt-actions">
              {(kind === "policies" && published(row)) || (kind === "faqs" && ["已审核", "已归档"].includes(row["状态"])) ? <>
                <button type="button" onClick={() => setAction({ type: "view", row })}>查看</button>
                {kind === "policies" && publications.has(policyKeyOf(row)) && <button type="button" onClick={() => setAction({ type: "publication", row })}>试算记录</button>}
                <button type="button" onClick={() => setAction({ type: "copy", row })}>新建版本</button></> : <>
                <button type="button" onClick={() => setAction({ type: "edit", row })}>编辑</button>
                {kind === "policies" && <button type="button" onClick={() => setAction({ type: "trial", row })}>试算与发布</button>}</>}
            </td></tr>)}</tbody>
        </table></div> : <div className="mt-empty"><Mark name={kind} /><strong>{search ? "没有找到匹配的资料" : loading ? "正在读取资料" : error ? "资料暂未载入" : "还没有" + section.name}</strong>
          {search && <button type="button" className="md-text-button" onClick={() => setSearch("")}>清除搜索</button>}</div>}
        {pages > 1 && <div className="mt-pages"><button type="button" disabled={activePage === 1} onClick={() => setPage(activePage - 1)}>上一页</button>
          <span>{activePage} / {pages}</span><button type="button" disabled={activePage === pages} onClick={() => setPage(activePage + 1)}>下一页</button></div>}
      </section></>}</main>
    </div>
    {action?.type === "import" && <MerchantImport onClose={close} onSaved={saved} />}
    {action?.type === "trial" && library && <MerchantTrial policy={action.row} orders={library.data.orders} policies={library.data.policies} onClose={close} onSaved={saved} />}
    {action?.type === "publication" && <MerchantPublication policy={action.row} onClose={close} />}
    {action && action.type !== "trial" && action.type !== "import" && action.type !== "publication" && library && <MerchantEditor library={library} kind={kind}
      mode={action.type} source={"row" in action ? action.row : undefined} onClose={close} onSaved={saved} />}
  </div>;
}
