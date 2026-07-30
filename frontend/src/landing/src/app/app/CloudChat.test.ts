import { createElement } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

import { type CloudEvent, type CloudSession, CloudAPI } from "@/lib/cloud-api";
import {
  clearChatEventCache,
  mergeChatEventCache,
} from "@/lib/cloud-chat-cache";
import { CloudChat, deriveTimeline, deriveTurnState } from "./CloudChat";

function event(
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
): CloudEvent {
  return {
    sessionId: "session-one",
    sequence,
    type,
    payload,
    createdAt: "2026-07-30T00:00:00Z",
  };
}

const session: CloudSession = {
  id: "session-one",
  projectId: "project-one",
  kind: "orchestrator",
  harness: "claude-code",
  displayName: "Orchestrator",
  branch: "main",
  activityState: "idle",
  status: "idle",
  capabilities: ["chat.stream-json.v1"],
  runtimeConnected: true,
  isTerminated: false,
  createdAt: "2026-07-30T00:00:00Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function testAPI(overrides: Record<string, unknown> = {}) {
  return {
    chatEvents: vi.fn().mockResolvedValue({ events: [] }),
    activeTurn: vi.fn().mockResolvedValue({ turn: null }),
    streamEvents: vi.fn(
      (_sessionId: string, _after: number, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    ),
    sendMessage: vi.fn(),
    interruptSession: vi.fn().mockResolvedValue({
      event: event(3, "chat.interrupt_requested", { source: "browser" }),
    }),
    ...overrides,
  } as unknown as CloudAPI;
}

beforeEach(() => clearChatEventCache());

it("keeps only conversational content and actionable events in the timeline", () => {
  const timeline = deriveTimeline([
    event(1, "chat.user_message", { text: "Fix the tests" }),
    event(2, "chat.reasoning_delta", { text: "Inspecting " }),
    event(3, "chat.assistant_delta", { text: "I found it." }),
    event(4, "chat.session_state_changed", { state: "running" }),
    event(5, "chat.usage_updated", { usage: { inputTokens: 42 } }),
    event(6, "chat.tool_input_delta", { partialJson: '{"path":' }),
    event(7, "chat.plan_updated", { detail: "Run verification" }),
    event(8, "chat.approval_requested", {
      id: "approval-one",
      question: "Allow deployment?",
    }),
  ]);

  expect(timeline.map(({ type }) => type)).toEqual([
    "user",
    "assistant",
    "action",
  ]);
  expect(timeline[2]).toMatchObject({
    type: "action",
    label: "Approval needed",
    detail: "Allow deployment?",
  });
});

it("filters raw lifecycle, usage, and provider metadata events", () => {
  const canonicalTypes = [
    "chat.session_started",
    "chat.session_state_changed",
    "chat.thread_started",
    "chat.thread_state_changed",
    "chat.usage_updated",
    "chat.plan_updated",
    "chat.diff_updated",
    "chat.approval_resolved",
    "chat.user_input_resolved",
    "chat.task_started",
    "chat.task_progress",
    "chat.task_completed",
    "chat.context_compacted",
    "chat.auth_status",
    "chat.rate_limits_updated",
    "chat.mcp_status_updated",
    "chat.model_rerouted",
  ];
  const timeline = deriveTimeline(
    canonicalTypes.map((type, index) =>
      event(index + 1, type, { detail: type }),
    ),
  );

  expect(timeline).toEqual([]);
});

it("merges tool completion and output into its compact started row", () => {
  const timeline = deriveTimeline([
    event(1, "chat.assistant_delta", { text: "I will inspect it." }),
    event(2, "chat.tool_started", {
      id: "tool-one",
      name: "Read",
      input: { path: "src/app.ts" },
    }),
    event(3, "chat.tool_input_delta", {
      id: "tool-one",
      partialJson: '{"path":"src/app.ts"}',
    }),
    event(4, "chat.tool_completed", {
      id: "tool-one",
      output: "file contents",
    }),
    event(5, "chat.assistant_delta", { text: "The issue is here." }),
  ]);

  expect(timeline.map(({ type }) => type)).toEqual([
    "assistant",
    "tool",
    "assistant",
  ]);
  expect(timeline[1]).toMatchObject({
    type: "tool",
    toolId: "tool-one",
    name: "Read",
    status: "completed",
    input: { path: "src/app.ts" },
    output: "file contents",
  });
});

it("derives active and awaiting states from chat events", () => {
  expect(
    deriveTurnState([
      event(1, "chat.user_message", { text: "Ship it" }),
      event(2, "chat.turn_started", {}),
    ]),
  ).toEqual({ turnActive: true, awaitingInput: false });
  expect(
    deriveTurnState([
      event(1, "chat.turn_started", {}),
      event(2, "chat.user_input_requested", { question: "Which branch?" }),
    ]),
  ).toEqual({ turnActive: false, awaitingInput: true });
  expect(
    deriveTurnState([
      event(1, "chat.turn_started", {}),
      event(2, "chat.turn_completed", {}),
    ]),
  ).toEqual({ turnActive: false, awaitingInput: false });
  expect(
    deriveTurnState([
      event(1, "chat.turn_started", {}),
      event(2, "chat.interrupt_requested", {}),
    ]),
  ).toEqual({ turnActive: false, awaitingInput: false });
  expect(
    deriveTurnState([
      event(1, "chat.turn_started", {}),
      event(2, "chat.turn_interrupted", {}),
    ]),
  ).toEqual({ turnActive: false, awaitingInput: false });
});

it("loads durable replay before showing the empty state", async () => {
  const replay = deferred<{ events: CloudEvent[] }>();
  const api = testAPI({
    chatEvents: vi.fn().mockReturnValue(replay.promise),
  });

  render(createElement(CloudChat, { api, session }));

  expect(screen.getByText("Loading conversation…")).toBeInTheDocument();
  expect(screen.queryByText("Ready for a task")).not.toBeInTheDocument();

  await act(async () => replay.resolve({ events: [] }));

  expect(await screen.findByText("Ready for a task")).toBeInTheDocument();
  expect(api.streamEvents).toHaveBeenCalledWith(
    "session-one",
    0,
    expect.any(AbortSignal),
    expect.any(Function),
    expect.any(Function),
  );
});

it("shows prefetched conversation history without another replay request", async () => {
  mergeChatEventCache(
    session.id,
    [event(1, "chat.assistant_delta", { text: "Already loaded" })],
    true,
  );
  const api = testAPI();

  render(createElement(CloudChat, { api, session }));

  expect(await screen.findByText("Already loaded")).toBeInTheDocument();
  expect(screen.queryByText("Loading conversation…")).not.toBeInTheDocument();
  expect(api.chatEvents).not.toHaveBeenCalled();
});

it("keeps an active session marked working when its chat unmounts", async () => {
  mergeChatEventCache(
    session.id,
    [event(1, "chat.user_message", { text: "Keep working" })],
    true,
  );
  const onTurnActiveChange = vi.fn();
  const activeSession: CloudSession = {
    ...session,
    activeTurn: {
      id: "turn-one",
      sessionId: session.id,
      userMessageSequence: 1,
      state: "running",
      attemptCount: 1,
      createdAt: "2026-07-30T00:00:00Z",
      updatedAt: "2026-07-30T00:00:00Z",
    },
  };
  const chat = render(
    createElement(CloudChat, {
      api: testAPI(),
      session: activeSession,
      onTurnActiveChange,
    }),
  );
  await waitFor(() =>
    expect(onTurnActiveChange).toHaveBeenCalledWith(session.id, true),
  );

  chat.unmount();

  expect(onTurnActiveChange).not.toHaveBeenCalledWith(session.id, false);
});

it("uses the AO logo for orchestrators and harness logos for workers", async () => {
  const orchestrator = render(
    createElement(CloudChat, { api: testAPI(), session }),
  );
  const aoLogo = await screen.findByAltText("Agent Orchestrator");
  expect(aoLogo).toHaveAttribute("src", "/ao-logo.svg");
  orchestrator.unmount();

  render(
    createElement(CloudChat, {
      api: testAPI({
        chatEvents: vi.fn().mockResolvedValue({
          events: [event(1, "chat.assistant_delta", { text: "Done" })],
        }),
      }),
      session: { ...session, kind: "worker", harness: "claude-code" },
    }),
  );
  const claudeLogo = await screen.findByAltText("Claude Code");
  expect(claudeLogo).toHaveAttribute("src", "/agents/claude-code.svg");
});

it("retries initial history replay when focus reconnects during loading", async () => {
  const firstReplay = deferred<{ events: CloudEvent[] }>();
  const chatEvents = vi
    .fn()
    .mockReturnValueOnce(firstReplay.promise)
    .mockResolvedValue({ events: [] });
  const api = testAPI({ chatEvents });

  render(createElement(CloudChat, { api, session }));
  expect(screen.getByText("Loading conversation…")).toBeInTheDocument();

  await act(async () => window.dispatchEvent(new Event("focus")));

  expect(await screen.findByText("Ready for a task")).toBeInTheDocument();
  expect(chatEvents).toHaveBeenCalledTimes(2);
  await act(async () => firstReplay.resolve({ events: [] }));
});

it("shows worker startup instead of thinking for a disconnected runtime", async () => {
  const api = testAPI({
    chatEvents: vi.fn().mockResolvedValue({
      events: [event(1, "chat.user_message", { text: "Wake up" })],
    }),
  });

  render(
    createElement(CloudChat, {
      api,
      session: { ...session, runtimeConnected: false },
    }),
  );

  expect(await screen.findByText("Waking up the VM…")).toBeInTheDocument();
  expect(
    screen.getByRole("status", { name: "Starting secure worker" }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
});

it("rotates VM startup copy every 4 seconds", async () => {
  vi.useFakeTimers();
  try {
    const api = testAPI({
      chatEvents: vi.fn().mockResolvedValue({
        events: [event(1, "chat.user_message", { text: "Wake up" })],
      }),
    });
    render(
      createElement(CloudChat, {
        api,
        session: { ...session, runtimeConnected: false },
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Waking up the VM…")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(4_000));

    expect(
      screen.getByText("The VM was fast asleep. One moment…"),
    ).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it("rotates thinking copy every 4 seconds with an animated wave", async () => {
  vi.useFakeTimers();
  try {
    const api = testAPI({
      chatEvents: vi.fn().mockResolvedValue({
        events: [event(1, "chat.user_message", { text: "Keep going" })],
      }),
    });
    const { container } = render(
      createElement(CloudChat, {
        api,
        session: {
          ...session,
          activeTurn: {
            id: "turn-thinking",
            sessionId: session.id,
            userMessageSequence: 1,
            state: "running",
            attemptCount: 1,
            createdAt: "2026-07-30T00:00:00Z",
            updatedAt: "2026-07-30T00:00:00Z",
          },
        },
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Agent is thinking" }),
    ).toBeInTheDocument();
    expect(container.querySelector(".cloud-thinking-wave")).not.toBeNull();
    expect(container.querySelector(".cloud-thinking-wave-icon")).not.toBeNull();

    act(() => vi.advanceTimersByTime(4_000));

    expect(screen.getByText("Tracing the next move…")).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it("probes the durable turn and reconnects when the window regains focus", async () => {
  const api = testAPI();
  render(createElement(CloudChat, { api, session }));
  expect(await screen.findByText("Ready for a task")).toBeInTheDocument();

  window.dispatchEvent(new Event("focus"));

  await waitFor(() =>
    expect(api.activeTurn).toHaveBeenCalledWith("session-one"),
  );
  await waitFor(() => expect(api.streamEvents).toHaveBeenCalledTimes(2));
});

it("routes worker localhost links into the workspace browser", async () => {
  const user = userEvent.setup();
  const onOpenPreview = vi.fn();
  const api = testAPI({
    chatEvents: vi.fn().mockResolvedValue({
      events: [
        event(1, "chat.assistant_message", {
          text: "[Open preview](http://localhost:4173/docs)",
        }),
      ],
    }),
  });

  render(createElement(CloudChat, { api, session, onOpenPreview }));
  await user.click(await screen.findByRole("link", { name: "Open preview" }));

  expect(onOpenPreview).toHaveBeenCalledWith("http://localhost:4173/docs");
});

it("replays messages, locks the composer, and interrupts an active turn", async () => {
  const api = testAPI({
    chatEvents: vi.fn().mockResolvedValue({
      events: [
        event(1, "chat.user_message", { text: "Fix the failing tests" }),
        event(2, "chat.turn_started", {}),
      ],
    }),
  });
  const user = userEvent.setup();

  render(createElement(CloudChat, { api, session }));

  expect(await screen.findByText("Fix the failing tests")).toBeInTheDocument();
  expect(screen.getByLabelText("Message the orchestrator")).toBeDisabled();
  expect(screen.queryByLabelText("Send message")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Interrupt response" }));

  await waitFor(() =>
    expect(api.interruptSession).toHaveBeenCalledWith("session-one"),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Message the orchestrator")).toBeEnabled(),
  );
});
