import { useState } from "react";

export function CopyTraceId({ value, label = "复制流程编号", compact = false }: {
  value: string; label?: string; compact?: boolean;
}) {
  const [result,setResult] = useState<"idle"|"copied"|"manual">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setResult("copied");
    } catch {
      setResult("manual");
    }
  }
  return <span className="copy-trace-tool">
    <button type="button" className="copy-trace-button" aria-label={label+" "+value} title={value} onClick={copy}>
      {result==="copied" ? "已复制" : compact ? "复制" : label}</button>
    {result==="manual" && <input readOnly aria-label="手动复制编号" value={value} autoFocus
      onFocus={e=>e.currentTarget.select()} />}
  </span>;
}
