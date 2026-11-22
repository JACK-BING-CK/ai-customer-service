import type { SVGProps } from "react";
import type { Connection } from "./useLiveFeed";
import { hubPath } from "../shared/pages";

const drawings = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  workflow: <><rect x="2.5" y="8" width="6" height="7" rx="1.5"/><rect x="16" y="2" width="5.5" height="6" rx="1.3"/><rect x="16" y="15.5" width="5.5" height="6" rx="1.3"/><path d="M8.5 11.5h3.7M12.2 5H16m-3.8 13.5H16M12.2 5v13.5"/></>,
  headset: <><path d="M3 13v-1a9 9 0 0 1 18 0v1M21 16v1a4 4 0 0 1-4 4h-3"/><rect x="3" y="12" width="4" height="6" rx="1.4"/><rect x="17" y="12" width="4" height="6" rx="1.4"/></>,
  sparkle: <><path d="M11 2.8c.8 5.4 2.8 7.4 8.2 8.2-5.4.8-7.4 2.8-8.2 8.2-.8-5.4-2.8-7.4-8.2-8.2 5.4-.8 7.4-2.8 8.2-8.2Z"/><path d="M19.5 15.5v6m-3-3h6"/></>,
  person: <><circle cx="12" cy="7.4" r="3.4"/><path d="M5 20v-1.4a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5V20"/></>,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
  back: <path d="M19 12H5m6 6-6-6 6-6"/>,
  send: <path d="M12 19V5m-6 6 6-6 6 6"/>,
  enter: <path d="M19 5v6a4 4 0 0 1-4 4H5m4 4-4-4 4-4"/>,
  chat: <path d="M20 11.5a7.8 7.8 0 0 1-8 7.5 8.2 8.2 0 0 1-3-.6L4 20l1.4-4.5A7.2 7.2 0 0 1 4 11.5 7.8 7.8 0 0 1 12 4a7.8 7.8 0 0 1 8 7.5Z"/>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></>,
  clock: <><circle cx="12" cy="12" r="8.5"/><path d="M12 8v4l3 2"/></>,
  leave: <path d="M10 4H5v16h5m4-3 5-5-5-5m-5 5h10"/>,
  check: <path d="m5 12 4 4 10-10"/>,
} satisfies Record<string, React.ReactNode>;

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: keyof typeof drawings }) {
  return (
    <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" {...props}>
      {drawings[name]}
    </svg>
  );
}

const connectionLabel: Record<Connection, string> = {
  connecting: "正在连接",
  online: "已连接",
  offline: "连接已断开",
  unauthorized: "连接失效",
};

export function ConnectionStatus({ connection }: { connection: Connection }) {
  return (
    <span className="connection" data-state={connection} role="status">
      <span className="connection-dot" aria-hidden="true" />
      {connectionLabel[connection]}
    </span>
  );
}

export function HubLink() {
  return <a className="header-link" href={hubPath}><Icon name="grid" width="16" height="16" /><span>工作导航</span></a>;
}

export function AppHeader({ agent, children }: { agent?: boolean; children?: React.ReactNode }) {
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <a className="brand" href={agent ? "/agent" : "/"}>
          <span className="brand-mark"><Icon name="headset" /></span>
          <span>客服中心{agent && <small> / 坐席台</small>}</span>
        </a>
        <div className="header-actions"><HubLink />{children}</div>
      </div>
    </header>
  );
}

export function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return <p className={error ? "notice notice-error" : "notice"} role={error ? "alert" : "status"}>{children}</p>;
}
