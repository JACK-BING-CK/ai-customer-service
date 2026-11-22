import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Message, Snapshot } from "../shared/protocol";
import type { CommerceCard } from "../shared/commerce";
import { CommerceResult } from "./CommerceCards";
import { makeRequestId, messageTime } from "./state";
import { Icon, Notice } from "./ui";

type DisplayMessage = Message & { streaming?: boolean };
const emptyMessages: DisplayMessage[] = [];
const Explanation = createContext<{ messageId: string; send: () => void } | null>(null);

const roleNames: Record<Message["role"], string> = {
  customer: "顾客",
  assistant: "AI 客服",
  agent: "人工客服",
  system: "系统通知",
};
const transcriptComponents = { Message: MessageRow, SystemMessage: MessageRow };

function toThreadMessage(message: DisplayMessage): ThreadMessageLike {
  const role = message.role === "customer" ? "user" : message.role === "system" ? "system" : "assistant";
  return {
    id: message.id,
    role,
    createdAt: new Date(message.at),
    content: [{ type: "text", text: message.text }],
    metadata: { custom: { actor: message.role, streaming: message.streaming, commerceCard: message.commerceCard } },
    ...(message.streaming ? { status: { type: "running" } } : {}),
  };
}

function MessageRow() {
  const actor = useAuiState((s) => s.message.metadata.custom?.actor) as Message["role"] | undefined;
  const role = useAuiState((s) => s.message.role);
  const createdAt = useAuiState((s) => s.message.createdAt);
  const streaming = useAuiState((s) => s.message.metadata.custom?.streaming) === true;
  const card = useAuiState((s) => s.message.metadata.custom?.commerceCard) as CommerceCard | undefined;
  const id = useAuiState((s) => s.message.id);
  const explain = useContext(Explanation);
  const sender = actor ?? (role === "user" ? "customer" : role === "system" ? "system" : "assistant");
  if (sender === "system") {
    return (
      <MessagePrimitive.Root className="system-message">
        <span className="sr-only">系统通知：</span>
        <Icon name="clock" width="14" height="14" />
        <MessagePrimitive.Parts />
      </MessagePrimitive.Root>
    );
  }

  return (
    <MessagePrimitive.Root className="message-row" data-role={sender}>
      <span className="message-avatar">
        <Icon name={sender === "assistant" ? "sparkle" : "person"} width="16" height="16" />
      </span>
      <div className="message-main">
        <div className="message-meta">
          <strong>{card ? "店铺服务" : roleNames[sender]}</strong>
          {!streaming && <time dateTime={createdAt.toISOString()}>{messageTime.format(createdAt)}</time>}
        </div>
        {card ? <CommerceResult card={card} onExplain={explain?.messageId === id ? explain.send : undefined} /> : <div className="message-bubble" data-streaming={streaming || undefined}>
          <MessagePrimitive.Parts />
          {streaming && <span className="stream-caret" aria-hidden="true" />}
        </div>}
      </div>
    </MessagePrimitive.Root>
  );
}

interface TranscriptProps {
  snapshot: Snapshot | null;
  onView?: (id: string | null) => void;
  disabled: boolean;
  draftOnly?: boolean;
  label: string;
  placeholder: string;
  empty?: ReactNode;
  composerNotice?: ReactNode;
  suggestions?: string[];
  explainReturns?: boolean;
  onSend: (text: string, requestId: string) => Promise<void>;
}

export function Transcript({ snapshot, onView, disabled, draftOnly = false, label, placeholder, empty, composerNotice, suggestions, explainReturns = false, onSend }: TranscriptProps) {
  const running = snapshot?.mode === "ai" && snapshot.generating;
  const [sending, setSending] = useState(false);
  const isSending = useRef(false);
  const currentAttempt = useRef<{ text: string; id: string } | null>(null);
  const [error, setError] = useState("");
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messages = useMemo<DisplayMessage[]>(() => {
    if (!snapshot) return emptyMessages;
    if (!running) return snapshot.messages;
    return [...snapshot.messages, {
      id: "stream-" + snapshot.id,
      role: "assistant",
      at: snapshot.updatedAt,
      text: snapshot.draft || "正在准备回复",
      streaming: true,
    }];
  }, [snapshot, running]);

  const onNew = useCallback(async (message: AppendMessage) => {
    const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim();
    if (!text || disabled || draftOnly || running || isSending.current) return;
    if (text.length > 2000) {
      setError("消息最多可输入 2000 个字符。");
      runtimeRef.current?.thread.composer.setText(text);
      return;
    }
    const attempt = currentAttempt.current?.text === text
      ? currentAttempt.current
      : { text, id: makeRequestId() };
    currentAttempt.current = attempt;
    isSending.current = true;
    setSending(true);
    setError("");
    try {
      await onSend(text, attempt.id);
      currentAttempt.current = null;
    } catch (failure) {
      const composer = runtimeRef.current?.thread.composer;
      if (composer?.getState().text === "") composer.setText(text);
      setError(failure instanceof Error ? failure.message : "消息未发送，请重试。");
    } finally {
      isSending.current = false;
      setSending(false);
    }
  }, [disabled, draftOnly, onSend, running]);

  const runtime = useExternalStoreRuntime({
    messages,
    onNew,
    convertMessage: toThreadMessage,
    isRunning: running,
    isDisabled: disabled || running || sending,
    isSendDisabled: draftOnly,
  });
  useEffect(() => {
    runtimeRef.current = runtime;
    return () => { runtimeRef.current = null; };
  }, [runtime]);

  const id = snapshot?.id;
  const latestCardMessage = snapshot?.messages.findLast(message => message.commerceCard);
  const lastCard = latestCardMessage?.commerceCard;
  const explain = explainReturns && !disabled && !running && !sending && snapshot?.mode === "ai"
    && lastCard?.kind === "return" && (lastCard.status === "expired" || lastCard.status === "eligible")
    ? { messageId: latestCardMessage!.id, send: () => runtime.thread.append("为什么？") } : null;
  useEffect(() => {
    if (!id || !onView) return;
    onView(id);
    return () => onView(null);
  }, [id, onView]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="transcript">
        <ThreadPrimitive.Viewport className="thread-viewport" aria-label={label} tabIndex={0}>
          <div className="thread-body">
            {messages.length === 0 && empty}
            <Explanation.Provider value={explain}>
              <ThreadPrimitive.Messages components={transcriptComponents} />
            </Explanation.Provider>
          </div>
        </ThreadPrimitive.Viewport>
        <div className="composer-area">
          {error && <Notice error>{error}</Notice>}
          {composerNotice}
          {suggestions && messages.length === 0 && !disabled && (
            <div className="suggestions" aria-label="常用问题">
              {suggestions.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => {
                  runtime.thread.composer.setText(suggestion);
                  inputRef.current?.focus();
                }}>
                  {suggestion}<Icon name="arrow" width="14" height="14" />
                </button>
              ))}
            </div>
          )}
          <ComposerPrimitive.Root className="composer">
            <ComposerPrimitive.Input
              ref={inputRef}
              aria-label={placeholder}
              maxLength={2000}
              rows={1}
              placeholder={placeholder}
              submitMode={draftOnly ? "none" : "enter"}
              unstable_insertNewlineOnTouchEnter
              addAttachmentOnPaste={false}
            />
            <ComposerPrimitive.Send className="send-button" aria-label="发送消息">
              <Icon name="send" width="20" height="20" />
            </ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
          <p className="composer-hint"><Icon name="enter" width="14" height="14" />{draftOnly ? "Enter 换行" : "Enter 发送，Shift + Enter 换行"}</p>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
