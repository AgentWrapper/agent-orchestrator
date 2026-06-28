/**
 * host/socket-server.ts — the standalone host PROCESS wiring.
 *
 * Wires the transport-agnostic `SessionHost` to a real `net` server (Unix socket
 * / named pipe) and the right provider driver, then survives parent exit (spawned
 * detached by index.ts). Owns: subscriber backpressure, the snapshot/live socket,
 * control-command handling, session.json metadata, signal-driven shutdown, and
 * provider dispatch (Claude SDK / GLM / MiMo / OpenAI Responses).
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import net from "node:net";
import { type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import {
  encodeLine,
  LineParser,
  sessionPaths,
  type ClientCommand,
  type SessionInfo,
} from "../protocol.js";
import { SessionHost, type Send, type SubscribeOptions } from "./session-host.js";
import { createEventLogSink } from "./history-log.js";
import {
  GLM_BASE_URL,
  MIMO_BASE_URL,
  runOpenAiCompatMode,
} from "../providers/openai-compatible.js";
import { applyMimoAnthropicEnv } from "../providers/mimo-anthropic.js";
import { runClaudeAgentMode } from "../providers/claude-agent-sdk.js";
import { OPENAI_BASE_URL, runOpenAiResponsesMode } from "../providers/openai-responses.js";
import { runCodexAppServerMode } from "../providers/codex-app-server.js";

// ===========================================================================
// Subscriber backpressure
// ===========================================================================

/**
 * Max bytes Node may buffer for ONE slow subscriber before the host drops it.
 * The host fans every event out to every subscriber synchronously; it cannot
 * pause its own turn for one laggard, so the only bound is a per-socket queue
 * limit. 8 MB is generous for a healthy UI (which drains in microseconds) yet
 * far below the multi-GB blowups a stalled/never-reading client could cause.
 */
export const SUBSCRIBER_BUFFER_CAP = 8 * 1024 * 1024;

/**
 * The minimal socket surface the subscriber sink needs — a testable seam so the
 * backpressure policy is unit-tested without a real `net.Socket`. `net.Socket`
 * structurally satisfies this (it has `destroyed`, `writableLength`, `write`,
 * `destroy`).
 */
export interface SubscriberSocket {
  readonly destroyed: boolean;
  readonly writableLength: number;
  write(data: string): boolean;
  destroy(): void;
}

/**
 * Build a per-subscriber send sink with backpressure. When a subscriber can't
 * keep up, `sock.write` returns false and Node buffers the unsent data in memory
 * (`writableLength` grows); once it passes `cap` we `destroy()` the socket so the
 * host doesn't balloon holding one slow client's entire backlog. destroy() fires
 * the socket's 'close' (next tick) → the caller's unsubscribe runs → `emit()`
 * stops fanning to it. Fast subscribers drain immediately and never approach the
 * cap, so this is a no-op for them.
 */
export function makeSubscriberSink(
  sock: SubscriberSocket,
  cap: number = SUBSCRIBER_BUFFER_CAP,
): Send {
  return (line: string) => {
    if (sock.destroyed) return;
    sock.write(line);
    if (sock.writableLength > cap) sock.destroy();
  };
}

// ===========================================================================
// Bounded subscribe (#1) — opt-in snapshot handshake
// ===========================================================================

/**
 * Grace window the connection holds the snapshot for, letting an opt-in
 * `{cmd:"subscribe",...}` (which a new client sends immediately on connect) arrive
 * BEFORE the default full snapshot is sent. A new client's command crosses the
 * local socket in well under this, so it sees no added latency; only an OLD client
 * (which never sends one) waits the full window before its full snapshot — the only
 * behavioral delta for old clients, and well below human perception.
 */
export const SUBSCRIBE_GRACE_MS = 75;

/** Type-guard for the opt-in subscribe command. */
export function isSubscribeCommand(
  obj: unknown,
): obj is { cmd: "subscribe"; tail_events?: number; since_seq?: number } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as { cmd?: unknown }).cmd === "subscribe"
  );
}

/** Pull the (validated) bounded-subscribe options out of a subscribe command. */
export function subscribeOptionsFrom(obj: {
  tail_events?: unknown;
  since_seq?: unknown;
}): SubscribeOptions {
  const opts: SubscribeOptions = {};
  if (typeof obj.tail_events === "number" && Number.isFinite(obj.tail_events)) {
    opts.tailEvents = obj.tail_events;
  }
  if (typeof obj.since_seq === "number" && Number.isFinite(obj.since_seq)) {
    opts.sinceSeq = obj.since_seq;
  }
  return opts;
}

// ===========================================================================
// System-prompt resolution
// ===========================================================================

/**
 * Resolve the PERSISTENT system-prompt addendum (persona + rules) for this
 * session. Returned content is appended to Claude Code's preset system prompt
 * via `query({ options.systemPrompt })`, so it is re-sent on EVERY request — it
 * therefore survives resume (host restart) by construction, unlike the turn-1
 * `AO_SDK_INITIAL_PROMPT` which is only submitted once.
 *
 * Two sources, inline first:
 *   - AO_SDK_APPEND_SYSTEM_PROMPT — literal content (used by tests / external callers)
 *   - AO_SDK_SYSTEM_PROMPT_FILE  — path to a file with the content (how the engine
 *     plumbs it: the orchestrator/worker prompt file already on disk, no env bloat)
 * Returns null when neither yields non-empty content → query() omits systemPrompt
 * entirely and behavior is exactly as before (default Claude Code preset only).
 */
export function readAppendSystemPrompt(): string | null {
  const inline = process.env.AO_SDK_APPEND_SYSTEM_PROMPT;
  if (inline && inline.trim().length > 0) return inline;
  const file = process.env.AO_SDK_SYSTEM_PROMPT_FILE;
  if (file) {
    try {
      const content = readFileSync(file, "utf-8");
      if (content.trim().length > 0) return content;
    } catch {
      /* missing/unreadable file → no append (fail-open, never break the spawn) */
    }
  }
  return null;
}

// ===========================================================================
// Provider dispatch
// ===========================================================================

/**
 * Decide whether THIS host runs the GLM, MiMo, or OpenAI branch. The parent
 * (agent plugin / runtime-sdk) resolves the provider via the central ModelRegistry
 * and passes it down as AO_SDK_PROVIDER; the host trusts that — the registry is the
 * single source of truth, the host does not re-guess. When AO_SDK_PROVIDER is
 * absent (a legacy/external spawn) it falls back to the original model-string
 * prefix, which routes the current GLM/MiMo models identically and maps the
 * gpt- and o-series prefixes to OpenAI (mirrors inferProviderFromId). A tiny pure
 * seam so the dispatch is unit-testable without a net server and the host needs
 * no @aoagents/ao-core import.
 */
export function resolveHostDispatch(
  provider: string | null | undefined,
  model: string | null | undefined,
): { isGlm: boolean; isMimo: boolean; isOpenai: boolean } {
  if (provider) {
    return {
      isGlm: provider === "zhipu",
      isMimo: provider === "mimo",
      isOpenai: provider === "openai",
    };
  }
  const m = (model ?? "").toLowerCase();
  return {
    isGlm: m.startsWith("glm-"),
    isMimo: m.startsWith("mimo-"),
    isOpenai: m.startsWith("gpt-") || /^o[1-4]/.test(m),
  };
}

// ===========================================================================
// Standalone entry-point
// ===========================================================================

export async function runStandalone(): Promise<void> {
  const aoSessionId = process.argv[2];
  if (!aoSessionId) {
    process.stderr.write("Usage: node sdk-host.js <aoSessionId>\n");
    process.exit(1);
  }

  const paths = sessionPaths(aoSessionId);
  mkdirSync(paths.base, { recursive: true });

  const permissionMode = (process.env.AO_SDK_PERMISSION_MODE ||
    "bypassPermissions") as PermissionMode;
  const resumeFrom = process.env.AO_SDK_RESUME || null;
  const model = process.env.AO_SDK_MODEL || null;
  const cwd = process.env.AO_SDK_CWD || process.cwd();
  const initialPrompt = process.env.AO_SDK_INITIAL_PROMPT || null;
  // Persistent persona/rules (orchestrator/worker) — appended to the Claude Code
  // preset system prompt and re-sent on every request, so it survives resume.
  const appendSystemPrompt = readAppendSystemPrompt();
  const permissionTimeoutMs = Number(process.env.AO_SDK_PERMISSION_TIMEOUT_MS || "0") || 0;
  const runtimeDriver = process.env.AO_SDK_RUNTIME_DRIVER ?? null;

  // Host-instance epoch: read the prior value from session.json (if any) and
  // advance it. Each host process for this AO session gets a higher epoch, so
  // subscribers detect a resurrected host deterministically.
  let priorEpoch = -1;
  try {
    const prev = JSON.parse(readFileSync(paths.sessionInfo, "utf-8")) as Partial<SessionInfo>;
    if (typeof prev.epoch === "number") priorEpoch = prev.epoch;
  } catch {
    /* no prior session.json — fresh epoch */
  }
  const epoch = priorEpoch + 1;

  const host = new SessionHost({
    aoSessionId,
    permissionMode,
    resumeFrom,
    model,
    permissionTimeoutMs,
    epoch,
    persist: createEventLogSink(paths.eventLog),
  });

  const writeSessionInfo = (sdkSessionId: string | null, modelName: string | null): void => {
    const info: SessionInfo = {
      aoSessionId,
      sdkSessionId,
      model: modelName,
      hostPid: process.pid,
      startedAt: new Date().toISOString(),
      resumedFrom: resumeFrom,
      epoch,
    };
    try {
      writeFileSync(paths.sessionInfo, JSON.stringify(info, null, 2));
    } catch {
      /* best effort */
    }
  };
  host.onSessionInfo = ({ sdkSessionId, model: m }) => writeSessionInfo(sdkSessionId, m);
  writeSessionInfo(resumeFrom, model);

  // --- net server: subscribers + control commands ---
  // The socket may live in a short, hashed dir distinct from the session base
  // (see protocol.socketAddress) — ensure it exists on POSIX.
  if (process.platform !== "win32") {
    mkdirSync(dirname(paths.socket), { recursive: true });
  }
  if (process.platform !== "win32" && existsSync(paths.socket)) {
    try {
      unlinkSync(paths.socket);
    } catch {
      /* stale socket cleanup is best effort */
    }
  }

  const server = net.createServer((sock) => handleConnection(host, sock));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  // Signal readiness to the parent (index.ts reads this before returning).
  process.stdout.write(`READY:${aoSessionId}\n`);

  const shutdown = (reason: string): void => {
    host.end();
    try {
      server.close();
    } catch {
      /* noop */
    }
    process.stderr.write(`sdk-host [${aoSessionId}] shutdown: ${reason}\n`);
    setTimeout(() => process.exit(0), 50).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  // --- start the streaming session (Claude SDK, GLM, MiMo, or OpenAI) ---
  const glmApiKey = process.env.AO_GLM_API_KEY ?? null;
  const mimoApiKey = process.env.AO_MIMO_API_KEY ?? null;
  const openaiApiKey = process.env.AO_OPENAI_API_KEY ?? null;
  // The provider for THIS session is resolved by the parent (agent plugin /
  // runtime-sdk) through the central ModelRegistry and handed down as
  // AO_SDK_PROVIDER. The host trusts it and does NOT re-guess from the model
  // string — that's the whole point of the registry (one source of truth).
  // Back-compat: a legacy/external spawn with no AO_SDK_PROVIDER falls back to
  // the original prefix dispatch, which routes the current GLM/MiMo models
  // identically. The host stays dependency-light (no @aoagents/ao-core import).
  const provider = process.env.AO_SDK_PROVIDER ?? null;
  const {
    isGlm: isGlmModel,
    isMimo: isMimoModel,
    isOpenai: isOpenaiModel,
  } = resolveHostDispatch(provider, model);

  // Escape hatch: force MiMo back onto the OpenAI-compat chat-loop (no tools,
  // no system prompt) — kept as a fallback in case the Anthropic-compatible
  // endpoint regresses. Off by default; the full-agent path below is primary.
  const mimoForceOpenAiCompat = process.env.AO_MIMO_FORCE_OPENAI_COMPAT === "1";

  const forceOpenAiResponses = process.env.AO_OPENAI_FORCE_RESPONSES === "1";
  const useCodexAppServer =
    isOpenaiModel && model && runtimeDriver === "codex-app-server" && !forceOpenAiResponses;

  if (glmApiKey && isGlmModel) {
    // ZhipuAI GLM path — OpenAI-compatible, no Claude SDK needed.
    await runOpenAiCompatMode(host, model!, glmApiKey, GLM_BASE_URL, cwd, initialPrompt, appendSystemPrompt);
  } else if (useCodexAppServer) {
    // OpenAI Codex app-server path — full agent behavior (tools, approvals,
    // sandbox, resume) normalized into the same runtime-sdk events as Claude.
    await runCodexAppServerMode(host, {
      cwd,
      permissionMode,
      appendSystemPrompt,
      resumeFrom,
      model,
      initialPrompt,
    });
  } else if (openaiApiKey && isOpenaiModel && model) {
    // OpenAI native path — the Responses API (POST /v1/responses, SSE). Text-only
    // fallback kept for AO_OPENAI_FORCE_RESPONSES=1 / legacy chat-only sessions.
    await runOpenAiResponsesMode(host, model, openaiApiKey, OPENAI_BASE_URL, cwd, initialPrompt, appendSystemPrompt);
  } else if (mimoApiKey && isMimoModel && mimoForceOpenAiCompat) {
    // MiMo legacy fallback — OpenAI-compatible chat loop (no agent tools).
    await runOpenAiCompatMode(host, model!, mimoApiKey, MIMO_BASE_URL, cwd, initialPrompt, appendSystemPrompt);
  } else {
    // MiMo (Xiaomi) FULL-AGENT path: point the Claude Agent SDK at MiMo's
    // Anthropic-compatible endpoint so MiMo gets tools + system prompt (our
    // orchestratorRules/agentRules) + discipline hooks for free, exactly like
    // a native Claude agent. applyMimoAnthropicEnv sets the ANTHROPIC_* env the
    // bundled SDK reads and DELETES ANTHROPIC_API_KEY so the real Anthropic key
    // can't override the MiMo token. Set per-session here (the parent strips
    // inherited ANTHROPIC_* before spawn), so a claude worker spawned from a mimo
    // session does NOT inherit MiMo's base/token — it goes to real Anthropic.
    if (mimoApiKey && isMimoModel && model) {
      applyMimoAnthropicEnv(model, mimoApiKey);
    }
    // Default: Claude via @anthropic-ai/claude-agent-sdk (or MiMo via the
    // Anthropic-compatible endpoint configured just above).
    await runClaudeAgentMode(host, {
      cwd,
      permissionMode,
      appendSystemPrompt,
      resumeFrom,
      model,
      initialPrompt,
    });
  }
  shutdown("session-ended");
}

/**
 * Wire one accepted connection to the host: backpressure sink, the #1 bounded-
 * subscribe grace handshake, the command parser, and teardown. Extracted from the
 * server callback so the arming logic is unit-testable with a fake socket + fake
 * timers (no real `net` server).
 *
 * Bounded subscribe: hold the snapshot until EITHER an opt-in `{cmd:"subscribe"}`
 * arrives (new client → bounded tail) OR the grace timer fires (old client → full
 * snapshot, the prior behavior). `arm` runs exactly once. Subscribing is atomic
 * (snapshot then join live, no await), so no event is missed or duplicated whenever
 * arming happens — events emitted during the grace window are in `host.events` and
 * land in the snapshot.
 */
export function handleConnection(host: SessionHost, sock: net.Socket): void {
  sock.setEncoding("utf-8");
  const sink = makeSubscriberSink(sock);

  let armed = false;
  let unsubscribe: (() => void) | null = null;
  const arm = (opts?: SubscribeOptions): void => {
    if (armed) return;
    armed = true;
    clearTimeout(graceTimer);
    unsubscribe = host.subscribe(sink, opts);
  };
  const graceTimer = setTimeout(() => arm(), SUBSCRIBE_GRACE_MS);
  graceTimer.unref?.();

  const parser = new LineParser((obj) => {
    // The subscribe command only takes effect BEFORE arming (it sets the snapshot
    // bounds). After arming it's a no-op (already streaming); any other command
    // routes to the normal handler. A late/duplicate subscribe is harmlessly ignored.
    if (!armed && isSubscribeCommand(obj)) {
      arm(subscribeOptionsFrom(obj));
      return;
    }
    handleClientCommand(host, sock, obj);
  });
  sock.on("data", (chunk) => parser.feed(chunk));
  sock.on("close", () => {
    clearTimeout(graceTimer);
    unsubscribe?.();
  });
  sock.on("error", () => {
    clearTimeout(graceTimer);
    unsubscribe?.();
  });
}

/** Handle one decoded client command line. */
export function handleClientCommand(host: SessionHost, sock: net.Socket, obj: unknown): void {
  if (typeof obj !== "object" || obj === null) return;
  const cmd = obj as ClientCommand;
  switch (cmd.cmd) {
    case "send":
      if (typeof cmd.text === "string") {
        // #2 ACK: confirm host receipt of the turn. `ok:false` means the host has
        // ended and dropped the turn — the UI flips the optimistic send to failed
        // instead of waiting out the delivery timeout. Deliberately carries NO
        // top-level `seq`: an old client decodes an unknown `type:"ack"` and would
        // dedup a real event by a colliding seq, so the ack must not look like a
        // data event (request_id is read only by the new client).
        const accepted = host.submitTurn(cmd.text) !== null;
        if (!sock.destroyed) sock.write(encodeLine({ type: "ack", cmd: "send", ok: accepted }));
      }
      break;
    case "status": {
      const s = host.status();
      if (!sock.destroyed) sock.write(encodeLine({ type: "status", ...s }));
      break;
    }
    case "output": {
      const text = host.renderOutput(typeof cmd.lines === "number" ? cmd.lines : 50);
      if (!sock.destroyed) sock.write(encodeLine({ type: "output", text }));
      break;
    }
    case "permission":
      if (typeof cmd.request_id === "string") {
        // #2 ACK: confirm the answer reached the host. `ok:false` means no such
        // pending request (already resolved / timed out / unknown id) → the UI can
        // re-surface the still-blocking card instead of silently dropping it.
        const resolved = host.resolvePermission(cmd.request_id, cmd.behavior, cmd.message);
        if (!sock.destroyed) {
          sock.write(
            encodeLine({ type: "ack", cmd: "permission", ok: resolved, request_id: cmd.request_id }),
          );
        }
      }
      break;
    case "kill":
      host.end();
      setTimeout(() => process.exit(0), 50).unref();
      break;
    default:
      break;
  }
}
