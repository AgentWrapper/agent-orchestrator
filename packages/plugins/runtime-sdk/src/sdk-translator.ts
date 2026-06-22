/**
 * sdk-translator.ts — the Anthropic Agent-SDK adapter.
 *
 * Translates raw `@anthropic-ai/claude-agent-sdk` messages into the normalized,
 * model-agnostic event bodies defined in event-schema.ts. This is the ONLY file
 * that knows Agent-SDK field names; everything downstream sees normalized
 * events. A sibling adapter for another provider would live next to this file
 * and emit the same `EventBody[]`.
 *
 * The host always runs with `includePartialMessages: true`, so assistant text
 * and reasoning arrive as `stream_event` deltas. We therefore translate
 * text/thinking from the stream and take only `tool_use` (with its complete,
 * decoded input) from the consolidated assistant message — emitting both would
 * duplicate the text.
 */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EventBody } from "./event-schema.js";

/** Minimal structural views of the nested SDK payloads we read. */
interface StreamDelta {
  type?: string;
  text?: string;
  thinking?: string;
}
interface StreamEventInner {
  type?: string;
  index?: number;
  delta?: StreamDelta;
}
interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Flatten an Anthropic tool_result `content` (string | block[]) into text. */
function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (isRecord(part) && typeof part.text === "string") return part.text;
        return JSON.stringify(part);
      })
      .join("");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

/**
 * Translate one SDK message into zero or more normalized event bodies.
 * The host stamps the envelope (v / seq / ts / session_id / turn).
 */
export function translateSdkMessage(msg: SDKMessage): EventBody[] {
  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init") {
        return [
          {
            type: "session",
            subtype: "init",
            session_id: msg.session_id,
            model: msg.model,
            cwd: msg.cwd,
            permission_mode: msg.permissionMode,
            tools: msg.tools,
          },
        ];
      }
      return [];
    }

    case "stream_event": {
      const ev = (msg as { event?: StreamEventInner }).event;
      if (!ev || ev.type !== "content_block_delta" || !ev.delta) return [];
      const block = typeof ev.index === "number" ? ev.index : 0;
      if (ev.delta.type === "text_delta" && typeof ev.delta.text === "string") {
        return [{ type: "text-delta", block, text: ev.delta.text }];
      }
      if (ev.delta.type === "thinking_delta" && typeof ev.delta.thinking === "string") {
        return [{ type: "reasoning", block, text: ev.delta.thinking }];
      }
      return [];
    }

    case "assistant": {
      const blocks = (msg.message?.content ?? []) as ContentBlock[];
      const out: EventBody[] = [];
      blocks.forEach((b, idx) => {
        if (b.type === "tool_use") {
          out.push({
            type: "tool_use",
            block: idx,
            id: b.id ?? "",
            name: b.name ?? "",
            input: isRecord(b.input) ? b.input : {},
          });
        }
      });
      return out;
    }

    case "user": {
      const content = msg.message?.content;
      if (!Array.isArray(content)) return [];
      const out: EventBody[] = [];
      for (const b of content as ContentBlock[]) {
        if (b.type === "tool_result") {
          out.push({
            type: "tool_result",
            tool_use_id: b.tool_use_id ?? "",
            is_error: b.is_error === true,
            content: stringifyToolContent(b.content),
          });
        }
      }
      return out;
    }

    case "result": {
      const usage = msg.usage;
      const events: EventBody[] = [
        {
          type: "result",
          subtype: msg.subtype,
          is_error: msg.is_error === true,
          text: msg.subtype === "success" ? msg.result : "",
          num_turns: msg.num_turns,
          duration_ms: msg.duration_ms,
        },
      ];
      events.push({
        type: "usage",
        input_tokens: usage?.input_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? 0,
        cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
        total_cost_usd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0,
        model: extractModel(msg.modelUsage),
      });
      return events;
    }

    default:
      return [];
  }
}

function extractModel(modelUsage: unknown): string {
  if (isRecord(modelUsage)) {
    const keys = Object.keys(modelUsage);
    if (keys.length > 0) return keys[0];
  }
  return "";
}
