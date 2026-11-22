import { useEffect, useRef, useState, type FormEvent } from "react";
import { io, type Socket } from "socket.io-client";
import { FlowMonitor } from "./FlowMonitor";
import { TraceExplorer } from "./TraceExplorer";
import { ConnectionStatus, HubLink, Icon, Notice } from "./ui";
import { useDiagnostics } from "./useDiagnostics";
import type { Connection } from "./useLiveFeed";

const credentialName = "support.debug.access";

export function Debug() {
  const [token, setToken] = useState(() => sessionStorage.getItem(credentialName) ?? "");
  const [input, setInput] = useState("");
  const [connection, setConnection] = useState<Connection>("connecting");
  const [selected, setSelected] = useState(() => {
    const id = new URLSearchParams(window.location.search).get("conversation") ?? "";
    return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ? id : "";
  });
  const [search, setSearch] = useState("");
  const params = new URLSearchParams(window.location.search);
  const traceQuery = params.get("trace");
  const socketRef = useRef<Socket | null>(null);
  const { report, error, refresh } = useDiagnostics(socketRef, connection, traceQuery === null, selected, search);

  useEffect(() => {
    const socket = io({ auth: { role: "debug", token }, autoConnect: false, reconnectionDelayMax: 3500 });
    socketRef.current = socket;
    setConnection("connecting");
    socket.on("diagnostics:ready", () => {
      setConnection("online");
      if (token) sessionStorage.setItem(credentialName, token);
    });
    socket.on("disconnect", () => setConnection("offline"));
    socket.on("connect_error", (e) => {
      if (e.data?.code === "UNAUTHORIZED") {
        sessionStorage.removeItem(credentialName);
        setConnection("unauthorized");
      } else setConnection("offline");
    });
    socket.connect();
    return () => { socket.removeAllListeners(); socket.disconnect(); socketRef.current = null; };
  }, [token]);

  useEffect(() => {
    if (!selected && report?.selected) setSelected(report.selected.id);
  }, [selected, report]);
  function signIn(event: FormEvent) {
    event.preventDefault();
    const key = input.trim();
    if (!key) return;
    if (key === token) socketRef.current?.connect();
    else setToken(key);
    setInput("");
  }

  return <div className="app debug-app">
    <header className="app-header">
      <div className="app-header-inner">
        <a className="brand" href="/debug">
          <span className="brand-mark"><Icon name="workflow" /></span>
          <span>调试后台</span>
        </a>
        <div className="header-actions"><HubLink /><ConnectionStatus connection={connection} /></div>
      </div>
    </header>
    {connection === "unauthorized" ? <main className="access-layout">
      <form className="access-card" onSubmit={signIn}>
        <h1>进入调试后台</h1>
        <label htmlFor="debug-access">本机访问密钥</label>
        <input id="debug-access" type="password" autoComplete="current-password" required value={input} onChange={e => setInput(e.target.value)} />
        {token && <Notice error>访问密钥无效，请重试。</Notice>}
        <button className="primary-button" type="submit">进入后台</button>
      </form>
    </main> : traceQuery !== null ? <TraceExplorer query={traceQuery} token={token} conversationId={selected}
      connection={connection} /> : <FlowMonitor report={report} connection={connection} error={error} selectedId={selected}
      initialView={params.get("view") === "session" ? "session" : "modules"}
      onSelect={setSelected} search={search} onSearch={value => { setSelected(""); setSearch(value); }}
      onRefresh={() => { if (connection === "offline") socketRef.current?.connect(); else refresh(); }} />}
  </div>;
}
