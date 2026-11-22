import { useState } from "react";
import { catalog, errorMessage, merchantRequest, sections, type ImportPreview } from "./merchant-library";
import { MerchantDialog, MerchantError } from "./MerchantDialog";

export function MerchantImport({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string) => void }) {
  const [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  function choose(file: File | null) {
    setFile(file); setPreview(null);
    setError(file && file.size > 5 * 1024 * 1024 ? "文件超过 5 MB，请分批导入。" : "");
  }
  async function submit(commit: boolean) {
    if (!file || (commit && !preview?.previewToken)) return;
    setBusy(true); setError("");
    try {
      const result = await merchantRequest<ImportPreview>("/import/" + (commit ? "commit" : "preview"), file,
        commit ? { "X-Import-Preview": preview!.previewToken! } : {});
      if (!result.ok) throw new Error(result.errors.join("\n"));
      if (commit) onSaved(result.changes ? `导入完成，已写入 ${result.changes} 条变更。` : "导入完成，资料与当前记录一致。");
      else setPreview(result);
    } catch (e) { setError(errorMessage(e)); setPreview(null); } finally { setBusy(false); }
  }
  return <MerchantDialog title="导入 Excel" onClose={onClose} busy={busy}>
    <div className="md-body">
      <p className="md-hint">使用店铺客服资料录入模板填写四张资料表。新政策导入为草稿，可在「政策版本」试算后发布。</p>
      <div className="md-file">
        <label htmlFor="merchant-upload">选择工作簿 <small>.xlsx · 最多 5 MB</small></label>
        <input id="merchant-upload" type="file" accept=".xlsx" disabled={busy} onChange={e => choose(e.target.files?.[0] || null)} />
        <a className="md-text-button" href="/api/merchant/template" download>下载 Excel 模板</a>
      </div>
      {preview && <section className="md-preview" aria-label="导入预览">
        <h3>导入预览</h3>
        <p className="md-hint">预计写入 {preview.changes} 条变更。展开资料表可核对示例行。</p>
        {!!preview.warnings?.length && <div className="md-warnings" role="status">{preview.warnings.map(text => <p key={text}>{text}</p>)}</div>}
        {sections.map(kind => <details key={kind} className="md-sample">
          <summary>{catalog[kind].name}<span>{preview.counts?.[kind] || 0} 行</span></summary>
          {preview.samples?.[kind]?.length ? preview.samples[kind]!.map((r, i) => <dl className="md-values" key={i}>
            {Object.entries(r).filter(([, value]) => value).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
          </dl>) : <p className="md-hint">此表没有待预览记录。</p>}
        </details>)}
      </section>}
      <MerchantError message={error} />
    </div>
    <footer className="md-footer"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="primary-button" disabled={busy || !file || file.size > 5 * 1024 * 1024} onClick={() => submit(!!preview)}>
        {busy ? "处理中…" : preview ? "确认导入" : "预览导入"}
      </button>
    </footer>
  </MerchantDialog>;
}
