import { useEffect, useId, useRef, type ReactNode } from "react";

export function MerchantDialog({ title, onClose, busy, children }: {
  title: string; onClose: () => void; busy?: boolean; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="merchant-dialog" aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="md-head"><h2 id={heading}>{title}</h2>
      <button className="md-close" disabled={busy} type="button" onClick={onClose} aria-label="关闭弹窗">×</button>
    </header>{children}
  </dialog>;
}

export function MerchantError({ message }: { message: string }) {
  return message ? <div className="md-error" role="alert">{message}</div> : null;
}
