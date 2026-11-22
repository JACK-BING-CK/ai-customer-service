import { useEffect, useRef, useState, type RefObject } from "react";
import type { Socket } from "socket.io-client";
import type { DiagnosticReply, DiagnosticReport } from "../shared/diagnostics";
import type { Connection } from "./useLiveFeed";

export function useDiagnostics(socketRef: RefObject<Socket | null>, connection: Connection,
  enabled: boolean, selectedId: string, search: string) {
  const [result, setResult] = useState<{ scope: string; report: DiagnosticReport } | null>(null);
  const [error, setError] = useState("");
  const refresh = useRef<() => void>(() => {});
  const scope = JSON.stringify([selectedId, search]);

  useEffect(() => {
    if (!enabled || connection === "unauthorized") {
      setResult(null);
      setError("");
      return;
    }
    const socket = socketRef.current;
    if (!socket || connection !== "online") return;
    let closed = false;
    let reading = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout>;
    setError("");

    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(read, 100);
    }

    async function read() {
      if (closed || !socket?.connected) return;
      if (reading) { dirty = true; return; }
      reading = true;
      try {
        const reply: DiagnosticReply = await socket.timeout(5000).emitWithAck("debug:read", {
          id: selectedId || undefined, search: search.trim() || undefined,
        });
        if (closed) return;
        if (!reply.ok) throw new Error(reply.error);
        setResult({ scope, report: reply.report });
        setError("");
      } catch (cause) {
        if (!closed) setError(cause instanceof Error && cause.message !== "operation has timed out"
          ? cause.message : "暂时无法获取最新状态，请重试。");
      } finally {
        reading = false;
        if (dirty && !closed) { dirty = false; schedule(); }
      }
    }

    refresh.current = read;
    socket.on("diagnostics:changed", schedule);
    schedule();
    // The periodic read also recovers a missed notification or a transient read failure.
    const interval = setInterval(read, 5000);
    return () => {
      closed = true;
      clearTimeout(timer);
      clearInterval(interval);
      socket.off("diagnostics:changed", schedule);
      if (socket.connected) socket.emit("debug:leave");
      refresh.current = () => {};
    };
  }, [socketRef, scope, enabled, connection, selectedId, search]);

  return { report: result?.scope === scope ? result.report : null, error, refresh: () => refresh.current() };
}
