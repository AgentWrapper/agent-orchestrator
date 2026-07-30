import { expect, it } from "vitest";

import type { CloudEvent } from "@/lib/cloud-api";
import { deriveTimeline } from "./CloudChat";

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

it("renders messages, reasoning, tools, results, and unknown canonical events", () => {
  const timeline = deriveTimeline([
    event(1, "chat.user_message", { text: "Fix the tests" }),
    event(2, "chat.reasoning_delta", { text: "Inspecting " }),
    event(3, "chat.reasoning_delta", { text: "the suite" }),
    event(4, "chat.assistant_delta", { text: "I found it." }),
    event(5, "chat.tool_started", { id: "tool-one", name: "Bash" }),
    event(6, "chat.plan_updated", { detail: "Run verification" }),
    event(7, "chat.turn_completed", { isError: false }),
  ]);

  expect(timeline.map(({ type }) => type)).toEqual([
    "user",
    "reasoning",
    "assistant",
    "tool",
    "event",
    "result",
  ]);
  expect(timeline[1]).toMatchObject({
    type: "reasoning",
    text: "Inspecting the suite",
    streaming: false,
  });
  expect(timeline[4]).toMatchObject({
    type: "event",
    label: "Plan Updated",
    detail: "Run verification",
  });
});

it("keeps every provider lifecycle category visible instead of dropping it", () => {
  const canonicalTypes = [
    "chat.session_started",
    "chat.session_state_changed",
    "chat.thread_started",
    "chat.thread_state_changed",
    "chat.usage_updated",
    "chat.turn_started",
    "chat.turn_aborted",
    "chat.plan_updated",
    "chat.diff_updated",
    "chat.tool_progress",
    "chat.tool_completed",
    "chat.tool_failed",
    "chat.command_output",
    "chat.file_change_output",
    "chat.approval_requested",
    "chat.approval_resolved",
    "chat.user_input_requested",
    "chat.user_input_resolved",
    "chat.task_started",
    "chat.task_progress",
    "chat.task_completed",
    "chat.context_compacted",
    "chat.auth_status",
    "chat.rate_limits_updated",
    "chat.mcp_status_updated",
    "chat.model_rerouted",
    "chat.warning",
    "chat.error",
  ];
  const timeline = deriveTimeline(
    canonicalTypes.map((type, index) =>
      event(index + 1, type, { detail: type }),
    ),
  );

  expect(timeline).toHaveLength(canonicalTypes.length);
  expect(timeline.every(({ type }) => type === "event")).toBe(true);
});

it("preserves assistant and tool chronology within a turn", () => {
  const timeline = deriveTimeline([
    event(1, "chat.assistant_delta", { text: "I will inspect it." }),
    event(2, "chat.tool_started", { id: "tool-one", name: "Read" }),
    event(3, "chat.tool_completed", { id: "tool-one" }),
    event(4, "chat.assistant_delta", { text: "The issue is here." }),
  ]);

  expect(timeline.map(({ type }) => type)).toEqual([
    "assistant",
    "tool",
    "event",
    "assistant",
  ]);
  expect(timeline[0]).toMatchObject({ text: "I will inspect it." });
  expect(timeline[3]).toMatchObject({ text: "The issue is here." });
});
