import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { translateSdkMessage, pickPrimaryModel } from "../sdk-translator.js";
import type { UsageEventBody } from "../event-schema.js";

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
      models: [
        {
          model: "claude-opus-4-8",
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cost_usd: 0,
        },
      ],
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

  it("usage.model = PRIMARY model by max cost, not the first map key", () => {
    // Real-world shape: opus main + haiku auxiliary; haiku is the first key.
    const out = translateSdkMessage(
      m({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "x",
        num_turns: 1,
        duration_ms: 1,
        total_cost_usd: 0.0464,
        usage: {},
        modelUsage: {
          "claude-haiku-4-5": {
            costUSD: 0.00058,
            inputTokens: 507,
            outputTokens: 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          "claude-opus-4-8[1m]": {
            costUSD: 0.0458,
            inputTokens: 5808,
            outputTokens: 34,
            cacheReadInputTokens: 15246,
            cacheCreationInputTokens: 0,
          },
        },
      }),
    );
    const usage = out.find((e) => e.type === "usage") as UsageEventBody | undefined;
    expect(usage?.model).toBe("claude-opus-4-8[1m]"); // NOT "claude-haiku-4-5" (keys[0])
    expect(usage?.models.map((x) => x.model).sort()).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-8[1m]",
    ]);
    expect(usage?.models.find((x) => x.model === "claude-opus-4-8[1m]")).toMatchObject({
      input_tokens: 5808,
      cache_read_input_tokens: 15246,
      cost_usd: 0.0458,
    });
  });

  it("returns [] for unhandled message types", () => {
    expect(translateSdkMessage(m({ type: "system", subtype: "status" }))).toEqual([]);
    expect(translateSdkMessage(m({ type: "rate_limit_event" }))).toEqual([]);
  });
});

describe("pickPrimaryModel", () => {
  const model = (m: string, cost: number, inTok = 0, outTok = 0) => ({
    model: m,
    input_tokens: inTok,
    output_tokens: outTok,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cost_usd: cost,
  });

  it("picks the highest-cost model", () => {
    expect(pickPrimaryModel([model("aux", 0.0006), model("main", 0.045)])).toBe("main");
  });

  it("falls back to highest input+output tokens when no costs", () => {
    expect(pickPrimaryModel([model("aux", 0, 5, 1), model("main", 0, 500, 50)])).toBe("main");
  });

  it("prefers the session/init model on a cost tie", () => {
    expect(pickPrimaryModel([model("a", 0.01), model("b", 0.01)], "b")).toBe("b");
    // without a hint, the first tied entry wins
    expect(pickPrimaryModel([model("a", 0.01), model("b", 0.01)])).toBe("a");
  });

  it("handles single and empty maps", () => {
    expect(pickPrimaryModel([model("only", 0)])).toBe("only");
    expect(pickPrimaryModel([], "fallback")).toBe("fallback");
    expect(pickPrimaryModel([])).toBe("");
  });
});
