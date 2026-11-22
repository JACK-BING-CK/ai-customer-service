import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { Ack } from "../shared/protocol";
import type { CustomerSession } from "./state";

export type CommerceQuery =
  | { action: "order"; orderId: string }
  | { action: "return"; orderId: string; line?: number; quantity?: number }
  | { action: "faq"; text: string };

export type Connection = "connecting" | "online" | "offline" | "unauthorized";

type SocketAuth = ({ role: "customer" } & CustomerSession) | { role: "agent"; token: string; archive?: boolean };

type Requests = {
  "customer:send": { text: string; requestId: string };
  "customer:commerce": CommerceQuery & { requestId: string };
  "customer:handoff": Record<string, never>;
  "customer:resolve": {version:number};
  "agent:claim": { id: string };
  "agent:resolve": { id: string; version: number };
  "agent:send": { id: string; text: string; requestId: string };
};

type ConnectionError = Error & { data?: { code?: string } };

function acceptFeed<T>(_current: T | null, incoming: T) {
  return incoming;
}

export function useLiveFeed<T>(
  auth: SocketAuth | null,
  event: "snapshot" | "queue",
  merge: (current: T | null, incoming: T) => T = acceptFeed,
) {
  const socketRef = useRef<Socket | null>(null);
  const [feed, setFeed] = useState<T | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");

  useEffect(() => {
    setFeed(null);
    setConnection("connecting");
    if (!auth) return;

    const socket = io({ auth, autoConnect: false, reconnectionDelayMax: 3500 });
    socketRef.current = socket;

    socket.on("connect", () => setConnection("connecting"));
    socket.on("disconnect", (reason) => {
      setConnection("offline");
      if (reason === "io server disconnect") socket.connect();
    });
    socket.on("connect_error", (error: ConnectionError) => {
      setConnection(error.data?.code === "UNAUTHORIZED" ? "unauthorized" : "offline");
    });
    socket.on(event, (value: T) => {
      setFeed((current) => merge(current, value));
      setConnection("online");
    });
    socket.connect();

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [auth, event, merge]);

  const reconnect = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) return;
    socket.disconnect();
    setConnection("connecting");
    socket.connect();
  }, []);

  const request = useCallback(async <Event extends keyof Requests>(
    name: Event,
    payload: Requests[Event],
  ) => {
    const socket = socketRef.current;
    if (!socket?.connected) throw new Error("连接已断开，请连接后重试。");
    const ack = await new Promise<Ack>((resolve, reject) => {
      socket.timeout(12000).emit(name, payload, (error: Error | null, value: Ack) => {
        if (error || !value) {
          reject(new Error("未收到服务端确认，请稍后重试。"));
          return;
        }
        resolve(value);
      });
    });
    if (!ack.ok) throw new Error(ack.error || "暂时无法完成操作，请重试。");
  }, []);

  const reportView = useCallback((id: string | null) => {
    if (socketRef.current?.connected && connection === "online") {
      socketRef.current.emit("client:view", { id });
    }
  }, [connection]);

  return { feed, connection, reconnect, request, reportView };
}
