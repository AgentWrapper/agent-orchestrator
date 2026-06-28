/**
 * providers/openai-responses.ts — native OpenAI Responses API driver.
 *
 * Streams a session against POST /v1/responses (stream:true SSE) and NORMALIZES
 * the Responses event stream into the SAME model-agnostic events as the Claude
 * path (event-schema.ts) — text deltas → `text-delta`, reasoning summary →
 * `reasoning`, `response.completed` → `result` + real `usage`, API/stream errors
 * → typed `error(fatal)` (so the app surfaces the mae-226 banner, like the Claude
 * usage-limit path) — so downstream consumers (Maestro) render OpenAI turns with
 * NO changes.
 *
 * TEXT-ONLY for now (capabilities.tools=false in the registry): no tool execution.
 * The tool bridge (OpenAI function-calling → our permission flow → tool_outputs)
 * lands in a later phase.
 *
 * Conversation state is kept LOCALLY as an `input` array (role/content), re-sent
 * on every request — the same approach as openai-compatible.ts, NOT the server-
 * side `previous_response_id`. That keeps the driver provider-state-free and makes
 * it behave exactly like the GLM/MiMo chat loop across turns.
 *
 * This driver mirrors the openai-compatible.ts contract: it announces a synthetic
 * session/init, drains host.input turn by turn, and emits one result(+usage) per
 * turn, so SessionHost (subscribe/turn/seq/snapshot) needs no changes.
 */

import type { SessionHost } from "../host/session-host.js";
import type { UsageEventBody } from "../event-schema.js";

/** OpenAI Responses API base. Overridable per-session via AO_OPENAI_BASE_URL. */
export const OPENAI_BASE_URL = process.env.AO_OPENAI_BASE_URL ?? "https://api.openai.com/v1";

/** Token accounting as reported by `response.completed` (only fields we use). */
interface OpenAiResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

/** One parsed SSE `data:` payload from the Responses stream (only fields we use). */
interface ResponsesStreamChunk {
  type?: string;
  /** Incremental text/reasoning delta on response.*.delta events. */
  delta?: string;
  /** Full response object on response.completed / response.failed. */
  response?: {
    model?: string;
    usage?: OpenAiResponsesUsage | null;
    error?: { message?: string } | null;
  };
  /** Top-level `error` event. */
  message?: string;
  error?: { message?: string };
}

/** Best-effort human message from an HTTP error body ({error:{message}} or raw). */
async function safeErrorMessage(resp: Response): Promise<string> {
  try {
    const body = await resp.text();
    try {
      const j = JSON.parse(body) as { error?: { message?: string } };
      if (j.error?.message) return j.error.message;
    } catch {
      /* not JSON — fall through to raw body */
    }
    return body || resp.statusText;
  } catch {
    return resp.statusText;
  }
}

/** Build the normalized usage event from the Responses token report. */
export function buildUsageEvent(
  usage: OpenAiResponsesUsage | null | undefined,
  model: string,
): UsageEventBody {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cacheRead = usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    type: "usage",
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    // OpenAI does not expose a cache-CREATION figure; report 0 (honest).
    cache_creation_input_tokens: 0,
    // Cost is not computed here (no price table); the consumer derives it.
    total_cost_usd: 0,
    model,
    models: [
      {
        model,
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: 0,
        cost_usd: 0,
      },
    ],
  };
}

/**
 * Drive the host using the OpenAI Responses API. Emits the same normalized events
 * as the Claude path so downstream consumers (Maestro) need no changes. Used for
 * the `openai` provider (registry runtimeDriver `openai-responses`).
 */
export async function runOpenAiResponsesMode(
  host: SessionHost,
  model: string,
  apiKey: string,
  baseUrl: string,
  cwd: string,
  initialPrompt: string | null,
  appendSystemPrompt: string | null = null,
): Promise<void> {
  // Announce session init — gives the Swift side a session_id and model name.
  const providerSessionId = `openai-${Date.now()}`;
  host.emit(
    {
      type: "session",
      subtype: "init",
      session_id: providerSessionId,
      model,
      cwd,
      permission_mode: "bypassPermissions",
      tools: [],
    },
    0,
  );

  if (initialPrompt) host.submitTurn(initialPrompt);

  let turn = 0;
  const history: { role: "user" | "assistant" | "system"; content: string }[] = [];
  // Persona/rules as the leading system message so this path carries the same
  // persistent instructions as the Claude SDK path. Re-sent with every request.
  if (appendSystemPrompt) history.push({ role: "system", content: appendSystemPrompt });

  for await (const userMsg of host.input) {
    turn++;
    const userText =
      typeof userMsg.message.content === "string"
        ? userMsg.message.content
        : JSON.stringify(userMsg.message.content);

    history.push({ role: "user", content: userText });
    const startMs = Date.now();
    let fullText = "";
    let usage: OpenAiResponsesUsage | null = null;
    let usageModel = model;
    let streamError: string | null = null;

    try {
      const resp = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: history, stream: true }),
      });

      if (!resp.ok) {
        const errText = await safeErrorMessage(resp);
        // Typed FATAL: an OpenAI HTTP error (401 auth, 429 quota/rate-limit, 5xx)
        // is the analog of the Claude usage-limit, so it surfaces the mae-226
        // banner. The turn still closes cleanly via the result(error) below; the
        // loop continues so a later turn can succeed if the condition clears.
        host.emit(
          { type: "error", message: `OpenAI API error ${resp.status}: ${errText}`, fatal: true },
          turn,
        );
        host.emit(
          {
            type: "result",
            subtype: "error",
            is_error: true,
            text: "",
            num_turns: turn,
            duration_ms: Date.now() - startMs,
          },
          turn,
        );
        continue;
      }

      // --- SSE streaming response (Responses event protocol) ---
      // The stream interleaves `event:` and `data:` lines; the data payload carries
      // its own `type`, so we read ONLY `data:` lines and dispatch on that type.
      const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          // Responses ends with `response.completed` (no [DONE] sentinel); guard
          // for it anyway in case a proxy injects one.
          if (payload === "[DONE]") break outer;
          let chunk: ResponsesStreamChunk;
          try {
            chunk = JSON.parse(payload) as ResponsesStreamChunk;
          } catch {
            continue; // skip malformed SSE line
          }
          switch (chunk.type) {
            case "response.output_text.delta": {
              const delta = chunk.delta;
              if (typeof delta === "string" && delta.length > 0) {
                fullText += delta;
                host.emit({ type: "text-delta", block: 0, text: delta }, turn);
              }
              break;
            }
            case "response.reasoning_summary_text.delta": {
              // Reasoning summary deltas (present only when a summary is requested)
              // → thinking events. Defensive: not requested in this text-only phase.
              const delta = chunk.delta;
              if (typeof delta === "string" && delta.length > 0) {
                host.emit({ type: "reasoning", block: 0, text: delta }, turn);
              }
              break;
            }
            case "response.completed": {
              usage = chunk.response?.usage ?? null;
              if (chunk.response?.model) usageModel = chunk.response.model;
              break;
            }
            case "response.failed": {
              streamError = chunk.response?.error?.message ?? "response failed";
              break;
            }
            case "error": {
              streamError = chunk.error?.message ?? chunk.message ?? "stream error";
              break;
            }
            default:
              break;
          }
        }
      }

      // Keep history consistent even on a partial answer so the next turn has context.
      history.push({ role: "assistant", content: fullText });

      if (streamError) {
        host.emit({ type: "error", message: `OpenAI stream error: ${streamError}`, fatal: true }, turn);
        host.emit(
          {
            type: "result",
            subtype: "error",
            is_error: true,
            text: fullText,
            num_turns: turn,
            duration_ms: Date.now() - startMs,
          },
          turn,
        );
        continue;
      }

      host.emit(
        {
          type: "result",
          subtype: "success",
          is_error: false,
          text: fullText,
          num_turns: turn,
          duration_ms: Date.now() - startMs,
        },
        turn,
      );
      // Real token usage (unlike the openai-compat chat loop, which can only stub it).
      host.emit(buildUsageEvent(usage, usageModel), turn);
    } catch (err) {
      host.emit(
        {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
          fatal: true,
        },
        turn,
      );
      host.emit(
        {
          type: "result",
          subtype: "error",
          is_error: true,
          text: "",
          num_turns: turn,
          duration_ms: Date.now() - startMs,
        },
        turn,
      );
    }
  }

  host.end();
}
