/**
 * providers/openai-compatible.ts — OpenAI-compatible chat-completions driver.
 *
 * Shared implementation for ZhipuAI GLM (`glm-*`) and the MiMo legacy fallback
 * (`mimo-*` with AO_MIMO_FORCE_OPENAI_COMPAT=1). Emits the SAME normalized
 * events as the Claude path so downstream consumers (Maestro) need no changes.
 *
 * Only `delta.content` is extracted from each SSE chunk — `reasoning_content`
 * and other provider-specific fields are intentionally ignored.
 */

import type { SessionHost } from "../host/session-host.js";

export const GLM_BASE_URL =
  process.env.AO_GLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";
export const MIMO_BASE_URL = process.env.AO_MIMO_BASE_URL ?? "https://api.xiaomimimo.com/v1";

/**
 * Drive the host using any OpenAI-compatible chat completions API.
 * Used for ZhipuAI GLM (`glm-*`) and MiMo (`mimo-*`) providers instead of
 * the Claude SDK query(). Emits the same normalized events as the Claude path
 * so downstream consumers (Maestro) need no changes.
 *
 * Only `delta.content` is extracted from each SSE chunk — `reasoning_content`
 * and other provider-specific fields are intentionally ignored.
 */
export async function runOpenAiCompatMode(
  host: SessionHost,
  model: string,
  apiKey: string,
  baseUrl: string,
  cwd: string,
  initialPrompt: string | null,
  appendSystemPrompt: string | null = null,
): Promise<void> {
  // Announce session init — gives the Swift side a session_id and model name.
  const providerPrefix = model.split("-")[0] ?? "openai-compat";
  const providerSessionId = `${providerPrefix}-${Date.now()}`;
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
  // Persona/rules as the leading system message so this OpenAI-compatible path
  // (GLM, MiMo legacy fallback) carries the same persistent instructions as the
  // Claude SDK path. Re-sent with every /chat/completions request → survives resume.
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

    try {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages: history, stream: true }),
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        host.emit(
          { type: "error", message: `${providerPrefix.toUpperCase()} API error ${resp.status}: ${errBody}`, fatal: false },
          turn,
        );
        // Emit an error result so the turn closes cleanly in the UI.
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

      // --- SSE streaming response ---
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
          if (payload === "[DONE]") break outer;
          try {
            // Only extract delta.content — ignore reasoning_content and other fields.
            const chunk = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const delta = chunk.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              fullText += delta;
              host.emit({ type: "text-delta", block: 0, text: delta }, turn);
            }
          } catch {
            /* skip malformed SSE line */
          }
        }
      }

      history.push({ role: "assistant", content: fullText });

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
      // Emit a usage stub — token counts are not available from SSE streaming.
      host.emit(
        {
          type: "usage",
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          total_cost_usd: 0,
          model,
          models: [
            {
              model,
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              cost_usd: 0,
            },
          ],
        },
        turn,
      );
    } catch (err) {
      host.emit(
        {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
          fatal: false,
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

/** @deprecated Use runOpenAiCompatMode directly. Kept as a named alias for GLM. */
export function runGlmMode(
  host: SessionHost,
  model: string,
  apiKey: string,
  cwd: string,
  initialPrompt: string | null,
  appendSystemPrompt: string | null = null,
): Promise<void> {
  return runOpenAiCompatMode(host, model, apiKey, GLM_BASE_URL, cwd, initialPrompt, appendSystemPrompt);
}
