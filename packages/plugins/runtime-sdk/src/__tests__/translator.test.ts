import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { translateSdkMessage } from "../sdk-translator.js";

// Helper: cast loose fixtures to SDKMessage (full SDK shapes are huge; we only
// read the fields the translator touches).
const m = (obj: unknown): SDKMessage => obj as SDKMessage;

describe("translateSdkMessage", () => {
  it("maps system/init to a session/init event with provider id", () => {
    const out = translateSdkMessage(
      m({
        type: "system",
        subtype: "init",
        session_id: "sess-123",
        model: "claude-opus-4-8",
        cwd: "/work",
        permissionMode: "bypassPermissions",
        tools: ["Bash", "Write"],
      }),
    );
    expect(out).toEqual([
      {
        type: "session",
        subtype: "init",
        session_id: "sess-123",
        model: "claude-opus-4-8",
        cwd: "/work",
        permission_mode: "bypassPermissions",
        tools: ["Bash", "Write"],
      },
    ]);
  });

  it("maps a text_delta stream event to text-delta with block index", () => {
    const out = translateSdkMessage(
      m({
        type: "stream_event",
        event: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "hi" } },
      }),
    );
    expect(out).toEqual([{ type: "text-delta", block: 2, text: "hi" }]);
  });

  it("maps a thinking_delta stream event to reasoning", () => {
    const out = translateSdkMessage(
      m({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "hmm" },
        },
      }),
    );
    expect(out).toEqual([{ type: "reasoning", block: 0, text: "hmm" }]);
  });

  it("ignores signature_delta and non-delta stream events", () => {
    expect(
      translateSdkMessage(
        m({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta" } } }),
      ),
    ).toEqual([]);
    expect(
      translateSdkMessage(m({ type: "stream_event", event: { type: "message_start" } })),
    ).toEqual([]);
  });

  it("maps assistant tool_use blocks (only) to tool_use events", () => {
    const out = translateSdkMessage(
      m({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "already streamed" },
            { type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: "a", content: "b" } },
          ],
        },
      }),
    );
    expect(out).toEqual([
      { type: "tool_use", block: 1, id: "toolu_1", name: "Write", input: { file_path: "a", content: "b" } },
    ]);
  });

  it("maps user tool_result blocks (string and array content) to tool_result", () => {
    expect(
      translateSdkMessage(
        m({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } }),
      ),
    ).toEqual([{ type: "tool_result", tool_use_id: "toolu_1", is_error: false, content: "ok" }]);

    expect(
      translateSdkMessage(
        m({
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: [{ type: "text", text: "boom" }] },
            ],
          },
        }),
      ),
    ).toEqual([{ type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: "boom" }]);
  });

  it("maps result/success to result + usage events", () => {
    const out = translateSdkMessage(
      m({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        num_turns: 2,
        duration_ms: 1234,
        total_cost_usd: 0.5,
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_read_input_tokens: 1,
          cache_creation_input_tokens: 2,
        },
        modelUsage: { "claude-opus-4-8": {} },
      }),
    );
    expect(out[0]).toEqual({
      type: "result",
      subtype: "success",
      is_error: false,
      text: "done",
      num_turns: 2,
      duration_ms: 1234,
    });
    expect(out[1]).toEqual({
      type: "usage",
      input_tokens: 10,
      output_tokens: 3,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 2,
      total_cost_usd: 0.5,
      model: "claude-opus-4-8",
    });
  });

  it("result/error carries empty text (no result field on error)", () => {
    const out = translateSdkMessage(
      m({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        num_turns: 5,
        duration_ms: 10,
        usage: {},
        modelUsage: {},
      }),
    );
    expect(out[0]).toMatchObject({ type: "result", subtype: "error_max_turns", is_error: true, text: "" });
  });

  it("returns [] for unhandled message types", () => {
    expect(translateSdkMessage(m({ type: "system", subtype: "status" }))).toEqual([]);
    expect(translateSdkMessage(m({ type: "rate_limit_event" }))).toEqual([]);
  });
});
