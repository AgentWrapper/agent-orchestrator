import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { parseSessionTag, parseCallbackData } from "./shared.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TelegramListenerConfig {
  botToken?: string;
  chatId?: string;
  /** When false, the notifier does not auto-start the inbound listener. */
  listen?: boolean;
  /** When false, the whole integration is dormant. */
  enable?: boolean;
}

/** Resolve the AO state root (`~/.agent-orchestrator`), honouring $HOME. */
export function stateRoot(): string {
  const home = process.env.HOME || homedir() || ".";
  return join(home, ".agent-orchestrator");
}

/** Resolve the global config path (env override → state root default). */
export function configPath(): string {
  return process.env.AO_CONFIG_PATH || join(stateRoot(), "config.yaml");
}

/** Read `notifiers.telegram.*` from the AO config file. Never throws. */
export function readTelegramConfig(path = configPath()): TelegramListenerConfig {
  try {
    if (!existsSync(path)) return {};
    const doc = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown> | null;
    const notifiers = (doc?.notifiers ?? {}) as Record<string, unknown>;
    const tg = (notifiers.telegram ?? {}) as Record<string, unknown>;
    const chatId =
      typeof tg.chatId === "number"
        ? String(tg.chatId)
        : typeof tg.chatId === "string"
          ? tg.chatId
          : undefined;
    return {
      botToken: typeof tg.botToken === "string" ? tg.botToken : undefined,
      chatId,
      listen: tg.listen !== false,
      enable: tg.enable !== false,
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Telegram update parsing — pure, exported for tests
// ---------------------------------------------------------------------------

export interface ParsedMessage {
  kind: "message";
  updateId: number;
  chatId: string;
  text: string;
  replyToText?: string;
}

export interface ParsedCallback {
  kind: "callback";
  updateId: number;
  chatId?: string;
  callbackId: string;
  data: string;
}

export type ParsedUpdate = ParsedMessage | ParsedCallback;

/** Normalise a raw Telegram update into the parts we route on, or null. */
export function parseUpdate(update: unknown): ParsedUpdate | null {
  if (!update || typeof update !== "object") return null;
  const u = update as Record<string, any>;
  const updateId = typeof u.update_id === "number" ? u.update_id : -1;

  if (u.callback_query && typeof u.callback_query === "object") {
    const cq = u.callback_query as Record<string, any>;
    if (typeof cq.id !== "string" || typeof cq.data !== "string") return null;
    const chatId = cq.message?.chat?.id;
    return {
      kind: "callback",
      updateId,
      chatId: chatId != null ? String(chatId) : undefined,
      callbackId: cq.id,
      data: cq.data,
    };
  }

  const msg = u.message ?? u.edited_message;
  if (msg && typeof msg === "object") {
    const m = msg as Record<string, any>;
    if (typeof m.text !== "string") return null;
    const chatId = m.chat?.id;
    if (chatId == null) return null;
    return {
      kind: "message",
      updateId,
      chatId: String(chatId),
      text: m.text,
      replyToText: typeof m.reply_to_message?.text === "string" ? m.reply_to_message.text : undefined,
    };
  }

  return null;
}

export interface Route {
  sessionId: string;
  value: string;
  /** Set for inline-button presses so the loop can dismiss the spinner. */
  callbackId?: string;
}

/**
 * Decide where an update goes — pure. Foreign chats are ignored. A text reply
 * recovers its session from the quoted message's `ao:session=` tag; a button
 * press carries the session in its callback data.
 */
export function decideRoute(parsed: ParsedUpdate, expectedChatId?: string): Route | null {
  if (parsed.kind === "callback") {
    if (expectedChatId && parsed.chatId && parsed.chatId !== expectedChatId) return null;
    const target = parseCallbackData(parsed.data);
    if (!target) return null;
    return { sessionId: target.sessionId, value: target.value, callbackId: parsed.callbackId };
  }

  // message
  if (expectedChatId && parsed.chatId !== expectedChatId) return null;
  const sessionId = parseSessionTag(parsed.replyToText);
  if (!sessionId) return null; // not a reply to a tagged message → unroutable
  const value = parsed.text.trim();
  if (!value) return null;
  return { sessionId, value };
}

// ---------------------------------------------------------------------------
// `ao send` resolution — how the listener delivers a reply into a session
// ---------------------------------------------------------------------------

export interface AoCommand {
  cmd: string;
  baseArgs: string[];
}

/**
 * Resolve how to invoke the `ao` CLI. Prefers an explicit bundled engine
 * (AO_NODE + AO_CLI, set by Maestro / by the spawning notifier) so it works when
 * `ao` is not on PATH; otherwise falls back to a bare `ao` resolved from PATH.
 */
export function resolveAoCommand(env: NodeJS.ProcessEnv = process.env): AoCommand {
  const node = env.AO_NODE;
  const cli = env.AO_CLI;
  if (node && cli && existsSync(node) && existsSync(cli)) {
    return { cmd: node, baseArgs: [cli] };
  }
  return { cmd: "ao", baseArgs: [] };
}

/** Deliver `value` into `sessionId` via `ao send --no-wait`. Resolves on exit. */
export function sendToSession(
  sessionId: string,
  value: string,
  ao: AoCommand = resolveAoCommand(),
): Promise<boolean> {
  return new Promise((resolve) => {
    // `--` ends option parsing so a reply that starts with `-` (e.g. "-100") is
    // delivered as the message, not mistaken for a flag.
    const args = [...ao.baseArgs, "send", sessionId, "--no-wait", "--", value];
    const child = spawn(ao.cmd, args, {
      stdio: "ignore",
      env: process.env,
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

// ---------------------------------------------------------------------------
// Telegram Bot API (long-poll) — thin wrappers
// ---------------------------------------------------------------------------

const API_BASE = "https://api.telegram.org";

export function getUpdatesUrl(botToken: string, offset: number, timeoutSec: number): string {
  const params = new URLSearchParams({
    offset: String(offset),
    timeout: String(timeoutSec),
    allowed_updates: JSON.stringify(["message", "edited_message", "callback_query"]),
  });
  return `${API_BASE}/bot${botToken}/getUpdates?${params.toString()}`;
}

async function answerCallback(botToken: string, callbackId: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId, text: "Sent ✅" }),
    });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Single-instance lock
// ---------------------------------------------------------------------------

function lockPath(): string {
  return join(stateRoot(), "telegram-listener.pid");
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Acquire the listener lock; false if another live listener already holds it. */
export function acquireListenerLock(path = lockPath()): boolean {
  try {
    if (existsSync(path)) {
      const pid = parseInt(readFileSync(path, "utf8").trim(), 10);
      if (!Number.isNaN(pid) && pid !== process.pid && isPidAlive(pid)) return false;
    }
    writeFileSync(path, String(process.pid));
    return true;
  } catch {
    // If we can't use a lockfile, allow running (better to listen than not).
    return true;
  }
}

function releaseListenerLock(path = lockPath()): void {
  try {
    if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) {
      unlinkSync(path);
    }
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// The long-poll loop
// ---------------------------------------------------------------------------

const POLL_TIMEOUT_SEC = 25;

/** Run the inbound listener until the process is signalled. */
export async function runListener(cfg: TelegramListenerConfig = readTelegramConfig()): Promise<void> {
  const botToken = cfg.botToken;
  const chatId = cfg.chatId;
  if (!botToken || !chatId) {
    console.error("[telegram-listener] missing botToken/chatId; nothing to do.");
    return;
  }
  if (cfg.enable === false || cfg.listen === false) {
    console.error("[telegram-listener] disabled in config; exiting.");
    return;
  }
  if (!acquireListenerLock()) {
    console.error("[telegram-listener] another listener is already running; exiting.");
    return;
  }

  const ao = resolveAoCommand();
  let running = true;
  const stop = () => {
    running = false;
    releaseListenerLock();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  console.error(`[telegram-listener] listening (chat ${chatId})`);
  let offset = 0;
  let backoff = 1000;

  while (running) {
    try {
      const res = await fetch(getUpdatesUrl(botToken, offset, POLL_TIMEOUT_SEC));
      const json = (await res.json()) as { ok: boolean; result?: unknown[]; description?: string };
      if (!json.ok) {
        console.error(`[telegram-listener] getUpdates not ok: ${json.description ?? ""}`);
        await delay(backoff);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      backoff = 1000;
      for (const raw of json.result ?? []) {
        const parsed = parseUpdate(raw);
        if (parsed) offset = Math.max(offset, parsed.updateId + 1);
        if (!parsed) continue;
        const route = decideRoute(parsed, chatId);
        if (!route) continue;
        const ok = await sendToSession(route.sessionId, route.value, ao);
        console.error(
          `[telegram-listener] ${ok ? "delivered" : "FAILED"} → ${route.sessionId}: ${route.value.slice(0, 80)}`,
        );
        if (route.callbackId) await answerCallback(botToken, route.callbackId);
      }
    } catch (err) {
      // Network blip or aborted long-poll; back off and retry.
      console.error(`[telegram-listener] poll error: ${(err as Error).message}`);
      await delay(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Auto-spawn from the notifier plugin
// ---------------------------------------------------------------------------

/**
 * Spawn the inbound listener as a detached child of the daemon, unless: we're
 * under a test runner, listening is opted out, credentials are missing, or a
 * listener already holds the lock. Idempotent and side-effect-safe.
 */
export function maybeStartListener(config?: Record<string, unknown>): void {
  if (process.env.VITEST || process.env.AO_TELEGRAM_NO_LISTEN) return;
  if (config?.listen === false) return;
  const botToken = config?.botToken;
  const chatId = config?.chatId;
  if (!botToken || chatId == null || chatId === "") return;

  // Don't spawn a second listener if one is already alive.
  try {
    const lp = lockPath();
    if (existsSync(lp)) {
      const pid = parseInt(readFileSync(lp, "utf8").trim(), 10);
      if (!Number.isNaN(pid) && isPidAlive(pid)) return;
    }
  } catch {
    /* fall through to spawn */
  }

  try {
    const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    // Let the child reach `ao` even when it's not on PATH (bundled engine).
    childEnv.AO_NODE ??= process.execPath;
    const argv1 = process.argv[1];
    if (argv1 && /\.(c|m)?js$/.test(argv1) && existsSync(argv1)) childEnv.AO_CLI ??= argv1;
    if (typeof config?.configPath === "string") childEnv.AO_CONFIG_PATH ??= config.configPath;

    const child = spawn(process.execPath, [cliPath], {
      detached: true,
      stdio: "ignore",
      env: childEnv,
    });
    child.unref();
  } catch (err) {
    console.warn(`[notifier-telegram] could not start inbound listener: ${(err as Error).message}`);
  }
}

export { lockPath };
