import { createElement } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import {
  type CloudEvent,
  type CloudSession,
  CloudAPI,
} from "@/lib/cloud-api";
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
  );
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

  expect(await screen.findByText("Starting secure worker…")).toBeInTheDocument();
  expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
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
