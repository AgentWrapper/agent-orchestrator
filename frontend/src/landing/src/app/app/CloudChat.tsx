"use client";

import {
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  HelpCircle,
  LoaderCircle,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  CloudAPI,
  type CloudEvent,
  type CloudSession,
  type CloudTurn,
} from "@/lib/cloud-api";
import {
  mergeChatEventCache,
  readChatEventCache,
} from "@/lib/cloud-chat-cache";

interface CloudChatProps {
  api: CloudAPI;
  session: CloudSession;
  onTurnActiveChange?: (sessionId: string, active: boolean) => void;
}

type TimelineEntry =
  | { id: string; type: "user"; text: string }
  | { id: string; type: "assistant"; text: string; streaming: boolean }
  | {
      id: string;
      type: "tool";
      toolId: string;
      name: string;
      status: "running" | "completed" | "failed";
      input?: unknown;
      output?: unknown;
      inputText?: string;
    }
  | {
      id: string;
      type: "action";
      kind: "approval" | "question";
      label: string;
      detail?: string;
      resolved: boolean;
    }
  | {
      id: string;
      type: "notice";
      message: string;
      tone: "neutral" | "warning" | "error";
    };

function payloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function friendlyName(value: string) {
  return value
    .replaceAll("_", " ")
    .replaceAll(".", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function friendlyDetail(payload: Record<string, unknown>) {
  return (
    payloadString(payload, "question") ||
    payloadString(payload, "prompt") ||
    payloadString(payload, "message") ||
    payloadString(payload, "detail") ||
    payloadString(payload, "text") ||
    undefined
  );
}

function eventIdentity(event: CloudEvent) {
  return (
    payloadString(event.payload, "id") ||
    payloadString(event.payload, "requestId") ||
    payloadString(event.payload, "toolUseId")
  );
}

function setToolInputFromDelta(
  tool: Extract<TimelineEntry, { type: "tool" }>,
  partialJSON: string,
) {
  tool.inputText = `${tool.inputText ?? ""}${partialJSON}`;
  try {
    tool.input = JSON.parse(tool.inputText) as unknown;
  } catch {
    // Partial input remains hidden until the user expands the tool row.
  }
}

export function deriveTimeline(events: CloudEvent[]): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  let assistant: Extract<TimelineEntry, { type: "assistant" }> | undefined;
  const tools = new Map<string, Extract<TimelineEntry, { type: "tool" }>>();
  const actions = new Map<string, Extract<TimelineEntry, { type: "action" }>>();

  const finishAssistant = () => {
    if (assistant) assistant.streaming = false;
    assistant = undefined;
  };
  const latestRunningTool = () =>
    [...tools.values()].reverse().find(({ status }) => status === "running");

  for (const event of events) {
    switch (event.type) {
      case "chat.user_message":
        finishAssistant();
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
        break;
      }
      case "chat.reasoning_message": {
        break;
      }
      case "chat.tool_started": {
        finishAssistant();
        const toolId = eventIdentity(event) || `sequence-${event.sequence}`;
        const existing = tools.get(toolId);
        if (existing) {
          existing.name =
            payloadString(event.payload, "name") || existing.name || "Tool";
          existing.input = event.payload.input ?? existing.input;
          existing.status = "running";
          break;
        }
        const tool: Extract<TimelineEntry, { type: "tool" }> = {
          id: `tool-${event.sequence}`,
          type: "tool",
          toolId,
          name: payloadString(event.payload, "name") || "Tool",
          status: "running",
          input: event.payload.input,
        };
        tools.set(toolId, tool);
        timeline.push(tool);
        break;
      }
      case "chat.tool_input_delta": {
        const tool = tools.get(eventIdentity(event)) ?? latestRunningTool();
        const partialJSON = payloadString(event.payload, "partialJson");
        if (tool && partialJSON) setToolInputFromDelta(tool, partialJSON);
        break;
      }
      case "chat.tool_progress":
      case "chat.command_output":
      case "chat.file_change_output": {
        const tool = tools.get(eventIdentity(event)) ?? latestRunningTool();
        if (tool && event.payload.output !== undefined) {
          tool.output = event.payload.output;
        }
        break;
      }
      case "chat.tool_completed":
      case "chat.tool_failed": {
        const toolId = eventIdentity(event) || `sequence-${event.sequence}`;
        let tool = tools.get(toolId);
        if (!tool) {
          tool = {
            id: `tool-${event.sequence}`,
            type: "tool",
            toolId,
            name: payloadString(event.payload, "name") || "Tool",
            status: "running",
            input: event.payload.input,
          };
          tools.set(toolId, tool);
          timeline.push(tool);
        }
        tool.status =
          event.type === "chat.tool_failed" || event.payload.isError === true
            ? "failed"
            : "completed";
        tool.output = event.payload.output;
        break;
      }
      case "chat.approval_requested":
      case "chat.user_input_requested": {
        finishAssistant();
        const kind =
          event.type === "chat.approval_requested" ? "approval" : "question";
        const actionId =
          eventIdentity(event) || `${kind}-sequence-${event.sequence}`;
        const action: Extract<TimelineEntry, { type: "action" }> = {
          id: `action-${event.sequence}`,
          type: "action",
          kind,
          label: kind === "approval" ? "Approval needed" : "Input needed",
          detail: friendlyDetail(event.payload),
          resolved: false,
        };
        actions.set(actionId, action);
        timeline.push(action);
        break;
      }
      case "chat.approval_resolved":
      case "chat.user_input_resolved": {
        const kind =
          event.type === "chat.approval_resolved" ? "approval" : "question";
        const actionId = eventIdentity(event);
        const action =
          (actionId ? actions.get(actionId) : undefined) ??
          [...actions.values()]
            .reverse()
            .find(
              (candidate) => candidate.kind === kind && !candidate.resolved,
            );
        if (action) {
          action.resolved = true;
          action.detail = friendlyDetail(event.payload) ?? action.detail;
        }
        break;
      }
      case "chat.warning":
      case "chat.error": {
        finishAssistant();
        timeline.push({
          id: `notice-${event.sequence}`,
          type: "notice",
          message:
            friendlyDetail(event.payload) ??
            (event.type === "chat.error"
              ? "The response could not be completed."
              : "The agent reported a warning."),
          tone: event.type === "chat.error" ? "error" : "warning",
        });
        break;
      }
      case "chat.turn_aborted":
      case "chat.turn_interrupted":
        finishAssistant();
        timeline.push({
          id: `notice-${event.sequence}`,
          type: "notice",
          message: friendlyDetail(event.payload) ?? "Response stopped.",
          tone: "neutral",
        });
        break;
      case "chat.turn_completed": {
        finishAssistant();
        if (event.payload.isError === true) {
          timeline.push({
            id: `notice-${event.sequence}`,
            type: "notice",
            message:
              friendlyDetail(event.payload) ??
              "The response could not be completed.",
            tone: "error",
          });
        }
        break;
      }
      default:
        // Lifecycle, usage, session state, and unknown provider events are not
        // conversation content and intentionally stay out of the timeline.
        break;
    }
  }
  return timeline;
}

export function deriveTurnState(events: CloudEvent[], turnId?: string) {
  let turnActive = false;
  let awaitingInput = false;
  for (const event of events) {
    if (turnId && event.payload.turnId !== turnId) continue;
    switch (event.type) {
      case "chat.user_message":
      case "chat.turn_started":
      case "chat.assistant_delta":
      case "chat.reasoning_delta":
      case "chat.tool_started":
      case "chat.tool_progress":
      case "chat.tool_input_delta":
        turnActive = true;
        awaitingInput = false;
        break;
      case "chat.approval_requested":
      case "chat.user_input_requested":
        turnActive = false;
        awaitingInput = true;
        break;
      case "chat.approval_resolved":
      case "chat.user_input_resolved":
        turnActive = true;
        awaitingInput = false;
        break;
      case "chat.turn_completed":
      case "chat.turn_aborted":
      case "chat.interrupt_requested":
      case "chat.turn_interrupted":
      case "chat.error":
        turnActive = false;
        awaitingInput = false;
        break;
    }
  }
  return { turnActive, awaitingInput };
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

function displayToolValue(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Details are unavailable.";
  }
}

function ThinkingWave() {
  const path = "M1 8c4.5-8 8.5 8 15 0s10.5 8 15 0";
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 32 16"
      className="h-3 w-5 shrink-0 overflow-visible"
      fill="none"
    >
      <path d={path} stroke="#4b5058" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d={path}
        pathLength="1"
        stroke="#8eb6ff"
        strokeWidth="1.75"
        strokeLinecap="round"
        className="cloud-thinking-wave"
      />
    </svg>
  );
}

function ShimmerLabel({ children }: { children: string }) {
  return (
    <span className="animate-[cloud-shimmer_1.8s_ease-in-out_infinite] bg-gradient-to-r from-[#646a73] via-[#c5cad1] to-[#646a73] bg-[length:200%_100%] bg-clip-text text-transparent motion-reduce:animate-none">
      {children}
    </span>
  );
}

const vmStartupMessages = [
  "Waking up the VM…",
  "The VM was fast asleep. One moment…",
  "Pulling a fresh workspace off the shelf…",
  "Giving the worker its morning coffee…",
  "Booting the tiny cloud workshop…",
];

function RotatingVMStartupLabel() {
  const [messageIndex, setMessageIndex] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(
      () =>
        setMessageIndex((current) => (current + 1) % vmStartupMessages.length),
      3_500,
    );
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span key={messageIndex} className="cloud-startup-copy" aria-hidden="true">
      <ShimmerLabel>{vmStartupMessages[messageIndex]}</ShimmerLabel>
    </span>
  );
}

export function CloudChat({
  api,
  session,
  onTurnActiveChange,
}: CloudChatProps) {
  const [events, setEvents] = useState<CloudEvent[]>([]);
  const [pending, setPending] = useState<Array<{ id: string; text: string }>>(
    [],
  );
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replaySessionId, setReplaySessionId] = useState<string | null>(null);
  const [activeTurn, setActiveTurn] = useState<CloudTurn | null>(
    session.activeTurn ?? null,
  );
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const latestSequence = useRef(0);
  const loadedSessionId = useRef<string | null>(null);
  const historyLoadedSessionId = useRef<string | null>(null);
  const lastStreamActivity = useRef(Date.now());
  const turnProbeInFlight = useRef(false);
  const draftValue = useRef("");
  const retryIdempotencyKey = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveTurn(session.activeTurn ?? null);
  }, [session.activeTurn]);

  useEffect(() => {
    const controller = new AbortController();
    const isNewSession = loadedSessionId.current !== session.id;
    if (isNewSession) {
      const cached = readChatEventCache(session.id);
      loadedSessionId.current = session.id;
      historyLoadedSessionId.current = cached.hydrated ? session.id : null;
      latestSequence.current = cached.events.reduce(
        (latest, event) => Math.max(latest, event.sequence),
        0,
      );
      retryIdempotencyKey.current = null;
      followOutput.current = true;
      setEvents(cached.events);
      setPending([]);
      draftValue.current = "";
      setDraft("");
      setError(null);
      setReplaySessionId(cached.hydrated ? session.id : null);
      setInterrupting(false);
    }
    const needsHistoryReplay = historyLoadedSessionId.current !== session.id;
    const connect = async () => {
      if (needsHistoryReplay) {
        try {
          let replayAfter = 0;
          let replayed: CloudEvent[] = [];
          for (;;) {
            const replay = await api.chatEvents(session.id, replayAfter, 500);
            replayed = mergeEvents(replayed, replay.events);
            if (replay.events.length < 500) break;
            replayAfter = replay.events.reduce(
              (latest, event) => Math.max(latest, event.sequence),
              replayAfter,
            );
          }
          if (controller.signal.aborted) return;
          const chatEvents = replayed.filter((event) =>
            event.type.startsWith("chat."),
          );
          latestSequence.current = chatEvents.reduce(
            (latest, event) => Math.max(latest, event.sequence),
            0,
          );
          const cached = mergeChatEventCache(session.id, chatEvents, true);
          setEvents(cached.events);
        } catch (replayError) {
          if (controller.signal.aborted) return;
          setError(
            replayError instanceof Error
              ? `Could not load conversation history. ${replayError.message}`
              : "Could not load conversation history.",
          );
        } finally {
          if (!controller.signal.aborted) {
            historyLoadedSessionId.current = session.id;
            setReplaySessionId(session.id);
          }
        }
      }

      let retryDelay = 500;
      while (!controller.signal.aborted) {
        try {
          lastStreamActivity.current = Date.now();
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
                mergeChatEventCache(session.id, [event]);
                setEvents((current) => mergeEvents(current, [event]));
                const eventTurnID =
                  typeof event.payload.turnId === "string"
                    ? event.payload.turnId
                    : null;
                if (eventTurnID) {
                  if (event.type === "chat.turn_started") {
                    setActiveTurn((current) =>
                      current?.id === eventTurnID
                        ? { ...current, state: "running" }
                        : current,
                    );
                  } else if (
                    event.type === "chat.turn_completed" ||
                    event.type === "chat.turn_interrupted" ||
                    event.type === "chat.turn_aborted"
                  ) {
                    setActiveTurn((current) =>
                      current?.id === eventTurnID ? null : current,
                    );
                  }
                }
              }
              setError(null);
              retryDelay = 500;
            },
            () => {
              lastStreamActivity.current = Date.now();
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
          await new Promise((resolve) =>
            window.setTimeout(resolve, retryDelay),
          );
          retryDelay = Math.min(retryDelay * 2, 5_000);
        }
      }
    };
    void connect();
    return () => controller.abort();
  }, [api, reconnectNonce, session.id]);

  const probeTurnAndReconnect = useCallback(async () => {
    if (turnProbeInFlight.current) return;
    turnProbeInFlight.current = true;
    try {
      const { turn } = await api.activeTurn(session.id);
      setActiveTurn(turn);
    } catch {
      // The durable event replay remains authoritative if the status probe
      // fails during a transient network transition.
    } finally {
      turnProbeInFlight.current = false;
      lastStreamActivity.current = Date.now();
      setReconnectNonce((current) => current + 1);
    }
  }, [api, session.id]);

  useEffect(() => {
    const reconnect = () => void probeTurnAndReconnect();
    const reconnectWhenVisible = () => {
      if (document.visibilityState === "visible") reconnect();
    };
    window.addEventListener("focus", reconnect);
    window.addEventListener("online", reconnect);
    document.addEventListener("visibilitychange", reconnectWhenVisible);
    return () => {
      window.removeEventListener("focus", reconnect);
      window.removeEventListener("online", reconnect);
      document.removeEventListener("visibilitychange", reconnectWhenVisible);
    };
  }, [probeTurnAndReconnect]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (Date.now() - lastStreamActivity.current > 35_000) {
        void probeTurnAndReconnect();
      }
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [probeTurnAndReconnect]);

  useEffect(() => {
    if (followOutput.current) {
      endRef.current?.scrollIntoView?.({ block: "end" });
    }
  }, [events, pending]);

  const timeline = useMemo(() => deriveTimeline(events), [events]);
  const turnState = useMemo(
    () => deriveTurnState(events, activeTurn?.id),
    [activeTurn?.id, events],
  );
  const replayReady = replaySessionId === session.id;
  const responseActive =
    replayReady &&
    (sending ||
      pending.length > 0 ||
      activeTurn !== null ||
      turnState.turnActive);
  const hasUserMessage =
    pending.length > 0 ||
    events.some((event) => event.type === "chat.user_message");
  const structuredRuntimeReady =
    session.runtimeConnected &&
    session.capabilities?.includes("chat.stream-json.v1") === true;
  const visibleWorkInProgress = timeline.some(
    (entry) =>
      (entry.type === "assistant" && entry.streaming) ||
      (entry.type === "tool" && entry.status === "running"),
  );

  useEffect(() => {
    onTurnActiveChange?.(session.id, responseActive);
    return () => onTurnActiveChange?.(session.id, false);
  }, [onTurnActiveChange, responseActive, session.id]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || responseActive) return;
    const id = retryIdempotencyKey.current ?? crypto.randomUUID();
    followOutput.current = true;
    draftValue.current = "";
    setDraft("");
    setSending(true);
    setPending((current) => [...current, { id, text }]);
    try {
      const { event } = await api.sendMessage(session.id, text, id);
      setEvents((current) => mergeEvents(current, [event]));
      if (typeof event.payload.turnId === "string") {
        const now = new Date().toISOString();
        setActiveTurn({
          id: event.payload.turnId,
          sessionId: session.id,
          userMessageSequence: event.sequence,
          state: "provisioning",
          attemptCount: 0,
          createdAt: event.createdAt ?? now,
          updatedAt: now,
        });
      }
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

  const interrupt = async () => {
    if (!responseActive || interrupting) return;
    setInterrupting(true);
    try {
      const { event } = await api.interruptSession(session.id);
      setEvents((current) => mergeEvents(current, [event]));
      setActiveTurn((current) =>
        session.runtimeConnected && current
          ? { ...current, state: "cancel_requested" }
          : null,
      );
      setError(null);
    } catch (interruptError) {
      setError(
        interruptError instanceof Error
          ? interruptError.message
          : "Could not stop the response.",
      );
    } finally {
      setInterrupting(false);
    }
  };

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
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col overflow-x-hidden px-4 py-6 sm:px-5">
          {!replayReady ? (
            <div
              className="my-auto flex flex-col items-center py-16 text-center text-[#9ba1aa]"
              role="status"
              aria-live="polite"
            >
              <LoaderCircle
                className="size-5 animate-spin text-[#4d8dff] motion-reduce:animate-none"
                aria-hidden="true"
              />
              <span className="mt-3 text-xs">Loading conversation…</span>
            </div>
          ) : timeline.length === 0 && pending.length === 0 ? (
            <div className="my-auto py-16 text-center">
              <Bot className="mx-auto size-5 text-[#4d8dff]" />
              <h2 className="mt-3 text-sm font-medium">Ready for a task</h2>
              <p className="mt-1.5 text-xs leading-5 text-[#646a73]">
                Send a message to the orchestrator. Work continues in Fly even
                when this browser is closed.
              </p>
            </div>
          ) : (
            <div className="min-w-0 space-y-5">
              {timeline.map((entry) => {
                if (entry.type === "user") {
                  return (
                    <div key={entry.id} className="flex justify-end">
                      <div className="max-w-[88%] overflow-hidden break-words rounded-xl bg-[#1b1d22] px-3.5 py-2.5 text-sm leading-6 text-[#f4f5f7] sm:max-w-[82%]">
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
                          <span className="ml-1 inline-block size-1.5 animate-pulse rounded-full bg-[#4d8dff] motion-reduce:animate-none" />
                        ) : null}
                      </div>
                    </div>
                  );
                }
                if (entry.type === "tool") {
                  const hasDetails =
                    entry.input !== undefined ||
                    entry.inputText !== undefined ||
                    entry.output !== undefined;
                  const label =
                    entry.status === "running"
                      ? `Running ${friendlyName(entry.name)}…`
                      : entry.status === "failed"
                        ? `${friendlyName(entry.name)} failed`
                        : friendlyName(entry.name);
                  return (
                    <details
                      key={entry.id}
                      className="group ml-9 max-w-[calc(100%-2.25rem)] text-xs text-[#9ba1aa]"
                    >
                      <summary
                        className={`flex min-h-11 list-none items-center gap-2 rounded-md pr-1 outline-none focus-visible:ring-2 focus-visible:ring-[#4d8dff]/70 sm:min-h-8 ${
                          hasDetails ? "cursor-pointer" : "pointer-events-none"
                        }`}
                        aria-label={
                          hasDetails
                            ? `Show details for ${entry.name}`
                            : undefined
                        }
                      >
                        {entry.status === "running" ? (
                          <ThinkingWave />
                        ) : entry.status === "failed" ? (
                          <X className="size-3.5 shrink-0 text-[#ef6b6b]" />
                        ) : (
                          <Check className="size-3.5 shrink-0 text-[#74b98a]" />
                        )}
                        <span
                          className={
                            entry.status === "failed"
                              ? "font-medium text-[#ef8b8b]"
                              : "font-medium"
                          }
                        >
                          {entry.status === "running" ? (
                            <ShimmerLabel>{label}</ShimmerLabel>
                          ) : (
                            label
                          )}
                        </span>
                        {hasDetails ? (
                          <ChevronRight className="ml-auto size-3.5 shrink-0 text-[#646a73] transition-transform group-open:rotate-90 motion-reduce:transition-none" />
                        ) : null}
                      </summary>
                      {hasDetails ? (
                        <div className="ml-7 border-l border-white/[0.08] pl-3">
                          {entry.input !== undefined ||
                          entry.inputText !== undefined ? (
                            <div className="py-2">
                              <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[#646a73]">
                                Input
                              </div>
                              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-[#9ba1aa]">
                                {displayToolValue(
                                  entry.input ?? entry.inputText,
                                )}
                              </pre>
                            </div>
                          ) : null}
                          {entry.output !== undefined ? (
                            <div className="border-t border-white/[0.06] py-2">
                              <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[#646a73]">
                                Output
                              </div>
                              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-[#9ba1aa]">
                                {displayToolValue(entry.output)}
                              </pre>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </details>
                  );
                }
                if (entry.type === "action") {
                  const Icon =
                    entry.kind === "approval" ? CircleAlert : HelpCircle;
                  return (
                    <div
                      key={entry.id}
                      className="ml-9 flex max-w-xl items-start gap-2.5 rounded-lg border border-[#e8c14a]/20 bg-[#e8c14a]/[0.05] px-3 py-2.5"
                    >
                      {entry.resolved ? (
                        <Check className="mt-0.5 size-3.5 shrink-0 text-[#74b98a]" />
                      ) : (
                        <Icon className="mt-0.5 size-3.5 shrink-0 text-[#e8c14a]" />
                      )}
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-[#d7d7d2]">
                          {entry.resolved
                            ? `${entry.label} · Resolved`
                            : entry.label}
                        </div>
                        {entry.detail ? (
                          <p className="mt-1 break-words text-xs leading-5 text-[#9ba1aa]">
                            {entry.detail}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  );
                }
                if (entry.type === "notice") {
                  const toneClass = {
                    neutral: "text-[#9ba1aa]",
                    warning: "text-[#e8c14a]",
                    error: "text-[#ef6b6b]",
                  }[entry.tone];
                  return (
                    <div
                      key={entry.id}
                      className={`ml-9 flex items-start gap-2 text-xs leading-5 ${toneClass}`}
                      role={entry.tone === "error" ? "alert" : "status"}
                    >
                      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                      <span className="break-words">{entry.message}</span>
                    </div>
                  );
                }
                return null;
              })}
              {pending.map((message) => (
                <div key={message.id} className="flex justify-end opacity-60">
                  <div className="max-w-[88%] break-words rounded-xl bg-[#1b1d22] px-3.5 py-2.5 text-sm leading-6 sm:max-w-[82%]">
                    {message.text}
                  </div>
                </div>
              ))}
              {activeTurn?.state === "cancel_requested" ? (
                <div
                  className="ml-9 flex min-h-8 items-center gap-2 text-xs"
                  role="status"
                  aria-live="polite"
                >
                  <ThinkingWave />
                  <ShimmerLabel>Stopping response…</ShimmerLabel>
                </div>
              ) : hasUserMessage &&
                !structuredRuntimeReady &&
                responseActive ? (
                <div
                  className="ml-9 flex min-h-8 items-center gap-2 text-xs"
                  role="status"
                  aria-live="polite"
                  aria-label="Starting secure worker"
                >
                  <ThinkingWave />
                  <RotatingVMStartupLabel />
                </div>
              ) : responseActive && !visibleWorkInProgress ? (
                <div
                  className="ml-9 flex min-h-8 items-center gap-2 text-xs"
                  role="status"
                  aria-live="polite"
                >
                  <ThinkingWave />
                  <ShimmerLabel>Thinking…</ShimmerLabel>
                </div>
              ) : null}
              <div ref={endRef} />
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-white/[0.06] bg-[#0a0b0d] px-3 py-3 sm:px-4">
        <div className="mx-auto max-w-3xl">
          {error ? (
            <p role="alert" className="mb-2 text-xs text-[#ef6b6b]">
              {error}
            </p>
          ) : null}
          <div className="flex min-w-0 items-end gap-2 rounded-xl border border-white/10 bg-[#15171b] p-1.5 transition-colors focus-within:border-[#4d8dff]/60 sm:p-2">
            <textarea
              value={draft}
              disabled={!replayReady || responseActive}
              aria-label="Message the orchestrator"
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
              placeholder={
                !replayReady
                  ? "Loading conversation…"
                  : responseActive
                    ? "Response in progress…"
                    : "Tell the orchestrator what to build…"
              }
              className="max-h-48 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-2 py-2.5 text-sm leading-5 text-[#f4f5f7] [field-sizing:content] outline-none placeholder:text-[#646a73] disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-10 sm:py-2"
              rows={1}
            />
            {responseActive ? (
              <button
                type="button"
                onClick={() => void interrupt()}
                disabled={
                  interrupting || activeTurn?.state === "cancel_requested"
                }
                aria-label="Interrupt response"
                title="Interrupt response"
                className="grid size-11 shrink-0 place-items-center rounded-lg border border-white/15 bg-[#22252b] text-[#f4f5f7] transition-[background-color,transform,opacity] hover:bg-[#2a2e35] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d8dff] active:scale-95 disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none sm:size-8"
              >
                {interrupting ? (
                  <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Square className="size-3.5 fill-current" />
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!replayReady || !draft.trim()}
                aria-label="Send message"
                title="Send message"
                className="grid size-11 shrink-0 place-items-center rounded-lg bg-[#4d8dff] text-white transition-[background-color,transform,opacity] hover:bg-[#397df0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8bb5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#15171b] active:scale-95 disabled:cursor-not-allowed disabled:opacity-35 motion-reduce:transition-none sm:size-8"
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </div>
          <p className="mt-1.5 px-2 text-[10px] text-[#646a73]">
            Enter to send · Shift+Enter for newline
          </p>
        </div>
      </div>
    </div>
  );
}
