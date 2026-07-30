"use client";

import {
  ArrowUp,
  Bot,
  Check,
  LoaderCircle,
  Terminal,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { CloudAPI, type CloudEvent, type CloudSession } from "@/lib/cloud-api";

interface CloudChatProps {
  api: CloudAPI;
  session: CloudSession;
}

type TimelineEntry =
  | { id: string; type: "user"; text: string }
  | { id: string; type: "assistant"; text: string; streaming: boolean }
  | { id: string; type: "reasoning"; text: string; streaming: boolean }
  | { id: string; type: "tool"; name: string; input?: unknown }
  | { id: string; type: "result"; error: boolean; label: string }
  | {
      id: string;
      type: "event";
      label: string;
      detail?: string;
      payload: Record<string, unknown>;
      tone: "neutral" | "warning" | "error" | "success";
    };

function payloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function eventLabel(type: string) {
  return type
    .replace(/^chat\./, "")
    .replaceAll("_", " ")
    .replaceAll(".", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function eventTone(
  type: string,
): Extract<TimelineEntry, { type: "event" }>["tone"] {
  if (type.includes("error") || type.includes("failed")) return "error";
  if (
    type.includes("approval") ||
    type.includes("requested") ||
    type.includes("warning")
  )
    return "warning";
  if (type.includes("completed") || type.includes("resolved")) return "success";
  return "neutral";
}

export function deriveTimeline(events: CloudEvent[]): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  let assistant: Extract<TimelineEntry, { type: "assistant" }> | undefined;
  let reasoning: Extract<TimelineEntry, { type: "reasoning" }> | undefined;
  for (const event of events) {
    switch (event.type) {
      case "chat.user_message":
        assistant = undefined;
        reasoning = undefined;
        timeline.push({
          id: `event-${event.sequence}`,
          type: "user",
          text: payloadString(event.payload, "text"),
        });
        break;
      case "chat.assistant_delta": {
        const text = payloadString(event.payload, "text");
        if (!assistant || !assistant.streaming) {
          assistant = {
            id: `assistant-${event.sequence}`,
            type: "assistant",
            text: "",
            streaming: true,
          };
          timeline.push(assistant);
        }
        assistant.text += text;
        break;
      }
      case "chat.assistant_message": {
        const text = payloadString(event.payload, "text");
        if (!assistant || assistant.text.trim() === "") {
          assistant = {
            id: `assistant-${event.sequence}`,
            type: "assistant",
            text,
            streaming: false,
          };
          timeline.push(assistant);
        } else {
          assistant.streaming = false;
        }
        break;
      }
      case "chat.reasoning_delta": {
        const text = payloadString(event.payload, "text");
        if (!reasoning || !reasoning.streaming) {
          reasoning = {
            id: `reasoning-${event.sequence}`,
            type: "reasoning",
            text: "",
            streaming: true,
          };
          timeline.push(reasoning);
        }
        reasoning.text += text;
        break;
      }
      case "chat.reasoning_message": {
        const text = payloadString(event.payload, "text");
        if (!reasoning || reasoning.text.trim() === "") {
          reasoning = {
            id: `reasoning-${event.sequence}`,
            type: "reasoning",
            text,
            streaming: false,
          };
          timeline.push(reasoning);
        } else {
          reasoning.streaming = false;
        }
        break;
      }
      case "chat.tool_started":
        if (assistant) assistant.streaming = false;
        if (reasoning) reasoning.streaming = false;
        assistant = undefined;
        reasoning = undefined;
        timeline.push({
          id: `tool-${event.sequence}`,
          type: "tool",
          name: payloadString(event.payload, "name") || "Tool",
          input: event.payload.input,
        });
        break;
      case "chat.turn_completed": {
        if (assistant) assistant.streaming = false;
        if (reasoning) reasoning.streaming = false;
        const isError = event.payload.isError === true;
        timeline.push({
          id: `result-${event.sequence}`,
          type: "result",
          error: isError,
          label: isError ? "Turn failed" : "Completed",
        });
        assistant = undefined;
        reasoning = undefined;
        break;
      }
      default:
        if (event.type.startsWith("chat.")) {
          timeline.push({
            id: `event-${event.sequence}`,
            type: "event",
            label: eventLabel(event.type),
            detail:
              payloadString(event.payload, "detail") ||
              payloadString(event.payload, "message") ||
              payloadString(event.payload, "text") ||
              undefined,
            payload: event.payload,
            tone: eventTone(event.type),
          });
        }
    }
  }
  return timeline;
}

function mergeEvents(current: CloudEvent[], incoming: CloudEvent[]) {
  if (incoming.length === 0) return current;
  const bySequence = new Map(
    current.map((event) => [event.sequence, event] as const),
  );
  for (const event of incoming) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

export function CloudChat({ api, session }: CloudChatProps) {
  const [events, setEvents] = useState<CloudEvent[]>([]);
  const [pending, setPending] = useState<Array<{ id: string; text: string }>>(
    [],
  );
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestSequence = useRef(0);
  const draftValue = useRef("");
  const retryIdempotencyKey = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    latestSequence.current = 0;
    retryIdempotencyKey.current = null;
    followOutput.current = true;
    setEvents([]);
    setPending([]);
    draftValue.current = "";
    setDraft("");
    setError(null);
    const connect = async () => {
      let retryDelay = 500;
      while (!controller.signal.aborted) {
        try {
          await api.streamEvents(
            session.id,
            latestSequence.current,
            controller.signal,
            (event) => {
              latestSequence.current = Math.max(
                latestSequence.current,
                event.sequence,
              );
              if (event.type.startsWith("chat.")) {
                setEvents((current) => mergeEvents(current, [event]));
              }
              setError(null);
              retryDelay = 500;
            },
          );
          if (!controller.signal.aborted) {
            throw new Error("Live event stream disconnected.");
          }
        } catch (streamError) {
          if (controller.signal.aborted) return;
          setError(
            streamError instanceof Error
              ? `${streamError.message} Reconnecting…`
              : "Live event stream disconnected. Reconnecting…",
          );
          await new Promise((resolve) => window.setTimeout(resolve, retryDelay));
          retryDelay = Math.min(retryDelay * 2, 5_000);
        }
      }
    };
    void connect();
    return () => controller.abort();
  }, [api, session.id]);

  useEffect(() => {
    if (followOutput.current) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [events, pending]);

  const timeline = useMemo(() => deriveTimeline(events), [events]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const id = retryIdempotencyKey.current ?? crypto.randomUUID();
    followOutput.current = true;
    draftValue.current = "";
    setDraft("");
    setSending(true);
    setPending((current) => [...current, { id, text }]);
    try {
      const { event } = await api.sendMessage(session.id, text, id);
      setEvents((current) => mergeEvents(current, [event]));
      setPending((current) => current.filter((message) => message.id !== id));
      retryIdempotencyKey.current = null;
      setError(null);
    } catch (sendError) {
      if (draftValue.current === "") {
        retryIdempotencyKey.current = id;
        draftValue.current = text;
        setDraft(text);
      } else {
        retryIdempotencyKey.current = null;
      }
      setPending((current) => current.filter((message) => message.id !== id));
      setError(
        sendError instanceof Error
          ? sendError.message
          : "Could not send the message.",
      );
    } finally {
      setSending(false);
    }
  };

  const isWorking =
    session.status === "working" || session.activityState === "active";

  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] bg-[#0a0b0d]">
      <div
        ref={scrollRef}
        className="min-h-0 overflow-y-auto"
        onScroll={() => {
          const element = scrollRef.current;
          if (!element) return;
          followOutput.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            120;
        }}
      >
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-5 py-6">
          {timeline.length === 0 && pending.length === 0 ? (
            <div className="my-auto py-16 text-center">
              <Bot className="mx-auto size-5 text-[#4d8dff]" />
              <h2 className="mt-3 text-sm font-medium">Ready for a task</h2>
              <p className="mt-1.5 text-xs leading-5 text-[#646a73]">
                Send a message to the orchestrator. Work continues in Fly even
                when this browser is closed.
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {timeline.map((entry) => {
                if (entry.type === "user") {
                  return (
                    <div key={entry.id} className="flex justify-end">
                      <div className="max-w-[82%] rounded-xl bg-[#1b1d22] px-3.5 py-2.5 text-sm leading-6 text-[#f4f5f7]">
                        {entry.text}
                      </div>
                    </div>
                  );
                }
                if (entry.type === "assistant") {
                  return (
                    <div key={entry.id} className="flex gap-3">
                      <div className="mt-1 grid size-6 shrink-0 place-items-center rounded-md bg-[#15171b]">
                        <Bot className="size-3.5 text-[#9ba1aa]" />
                      </div>
                      <div className="prose prose-invert min-w-0 max-w-none flex-1 text-sm leading-6 text-[#d7d7d2] prose-headings:mb-2 prose-headings:mt-4 prose-headings:text-[#f4f5f7] prose-p:my-2 prose-p:text-[#d7d7d2] prose-pre:border prose-pre:border-white/[0.06] prose-pre:bg-[#15171b] prose-code:text-[#d7d7d2] prose-code:before:content-none prose-code:after:content-none prose-li:text-[#d7d7d2] prose-strong:text-[#f4f5f7]">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {entry.text}
                        </ReactMarkdown>
                        {entry.streaming ? (
                          <span className="ml-1 inline-block size-1.5 animate-pulse rounded-full bg-[#36c2b4] motion-reduce:animate-none" />
                        ) : null}
                      </div>
                    </div>
                  );
                }
                if (entry.type === "reasoning") {
                  return (
                    <details
                      key={entry.id}
                      className="ml-9 rounded-lg border border-white/[0.05] bg-white/[0.015]"
                    >
                      <summary className="cursor-pointer px-3 py-2 text-xs text-[#646a73]">
                        Reasoning{entry.streaming ? "…" : ""}
                      </summary>
                      <div className="whitespace-pre-wrap border-t border-white/[0.05] px-3 py-2.5 text-xs leading-5 text-[#9ba1aa]">
                        {entry.text}
                      </div>
                    </details>
                  );
                }
                if (entry.type === "tool") {
                  return (
                    <details
                      key={entry.id}
                      className="group ml-9 rounded-lg border border-white/[0.06] bg-[#15171b]"
                    >
                      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-[#9ba1aa]">
                        <Wrench className="size-3.5" />
                        <span className="font-medium text-[#d7d7d2]">
                          {entry.name}
                        </span>
                        <span className="ml-auto text-[#646a73]">
                          View input
                        </span>
                      </summary>
                      {entry.input !== undefined ? (
                        <pre className="overflow-x-auto border-t border-white/[0.06] p-3 font-mono text-[11px] leading-5 text-[#9ba1aa]">
                          {JSON.stringify(entry.input, null, 2)}
                        </pre>
                      ) : null}
                    </details>
                  );
                }
                if (entry.type === "event") {
                  const toneClass = {
                    neutral: "text-[#9ba1aa]",
                    warning: "text-[#e8c14a]",
                    error: "text-[#ef6b6b]",
                    success: "text-[#74b98a]",
                  }[entry.tone];
                  return (
                    <details
                      key={entry.id}
                      className="ml-9 rounded-lg border border-white/[0.05] bg-[#15171b]"
                    >
                      <summary
                        className={`cursor-pointer px-3 py-2 text-xs ${toneClass}`}
                      >
                        {entry.label}
                        {entry.detail ? ` · ${entry.detail}` : ""}
                      </summary>
                      <pre className="overflow-x-auto border-t border-white/[0.05] p-3 font-mono text-[11px] leading-5 text-[#646a73]">
                        {JSON.stringify(entry.payload, null, 2)}
                      </pre>
                    </details>
                  );
                }
                return (
                  <div
                    key={entry.id}
                    className={`ml-9 flex items-center gap-2 text-[11px] ${
                      entry.error ? "text-[#ef6b6b]" : "text-[#74b98a]"
                    }`}
                  >
                    {entry.error ? (
                      <Terminal className="size-3" />
                    ) : (
                      <Check className="size-3" />
                    )}
                    {entry.label}
                  </div>
                );
              })}
              {pending.map((message) => (
                <div key={message.id} className="flex justify-end opacity-60">
                  <div className="max-w-[82%] rounded-xl bg-[#1b1d22] px-3.5 py-2.5 text-sm leading-6">
                    {message.text}
                  </div>
                </div>
              ))}
              {isWorking ? (
                <div className="ml-9 flex items-center gap-2 text-xs text-[#646a73]">
                  <LoaderCircle className="size-3.5 animate-spin text-[#36c2b4] motion-reduce:animate-none" />
                  Working…
                </div>
              ) : null}
              <div ref={endRef} />
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-white/[0.06] bg-[#0a0b0d] px-4 py-3">
        <div className="mx-auto max-w-3xl">
          {error ? (
            <p role="alert" className="mb-2 text-xs text-[#ef6b6b]">
              {error}
            </p>
          ) : null}
          <div className="flex items-end gap-2 rounded-xl border border-white/10 bg-[#15171b] p-2 transition-colors focus-within:border-[#4d8dff]/60">
            <textarea
              value={draft}
              onChange={(event) => {
                retryIdempotencyKey.current = null;
                draftValue.current = event.target.value;
                setDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="Tell the orchestrator what to build…"
              className="max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-5 text-[#f4f5f7] [field-sizing:content] outline-none placeholder:text-[#646a73]"
              rows={1}
            />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!draft.trim() || sending}
              aria-label="Send message"
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#4d8dff] text-white transition-[opacity,transform] hover:bg-[#397df0] active:scale-95 disabled:cursor-not-allowed disabled:opacity-35 motion-reduce:transition-none"
            >
              {sending ? (
                <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </button>
          </div>
          <p className="mt-1.5 px-2 text-[10px] text-[#646a73]">
            Enter to send · Shift+Enter for newline
          </p>
        </div>
      </div>
    </div>
  );
}
