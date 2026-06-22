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
// Projects registry — resolve a `/orc <project>` token to its orchestrator
// ---------------------------------------------------------------------------

export interface ProjectRegistryEntry {
  projectId: string;
  sessionPrefix?: string;
  displayName?: string;
}

/** Read the `projects:` block from the AO config file. Never throws. */
export function readProjectsRegistry(path = configPath()): ProjectRegistryEntry[] {
  try {
    if (!existsSync(path)) return [];
    const doc = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown> | null;
    const projects = (doc?.projects ?? {}) as Record<string, unknown>;
    const out: ProjectRegistryEntry[] = [];
    for (const [key, value] of Object.entries(projects)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      out.push({
        projectId: typeof v.projectId === "string" ? v.projectId : key,
        sessionPrefix: typeof v.sessionPrefix === "string" ? v.sessionPrefix : undefined,
        displayName: typeof v.displayName === "string" ? v.displayName : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** A project's human-facing name for feedback messages (display → prefix → id). */
function projectLabel(entry: ProjectRegistryEntry): string {
  return entry.displayName || entry.sessionPrefix || entry.projectId;
}

export interface OrcResolution {
  /** Orchestrator session id for the matched project, or null if unknown. */
  sessionId: string | null;
  /** Human-facing list of available project names (for feedback messages). */
  available: string[];
}

/** Resolve a `/orc` project token to its orchestrator session, plus the menu. */
export type OrcResolver = (project: string) => OrcResolution;

/**
 * Build a resolver over a registry snapshot. A token matches (case-insensitive,
 * trimmed) on displayName, sessionPrefix, or projectId; the resolved session is
 * `<sessionPrefix>-orchestrator`.
 */
export function buildOrcResolver(entries: ProjectRegistryEntry[]): OrcResolver {
  const available = entries.map(projectLabel).filter(Boolean);
  return (project: string): OrcResolution => {
    const token = project.trim().toLowerCase();
    const match = token
      ? entries.find(
          (e) =>
            e.displayName?.toLowerCase() === token ||
            e.sessionPrefix?.toLowerCase() === token ||
            e.projectId.toLowerCase() === token,
        )
      : undefined;
    const sessionId = match?.sessionPrefix ? `${match.sessionPrefix}-orchestrator` : null;
    return { sessionId, available };
  };
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
  /** Message id of the quoted message (the bot's question), for deletion. */
  replyToMessageId?: number;
}

export interface ParsedCallback {
  kind: "callback";
  updateId: number;
  chatId?: string;
  callbackId: string;
  data: string;
  /** Message id carrying the inline keyboard (the bot's question), for deletion. */
  messageId?: number;
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
    const messageId = cq.message?.message_id;
    return {
      kind: "callback",
      updateId,
      chatId: chatId != null ? String(chatId) : undefined,
      callbackId: cq.id,
      data: cq.data,
      messageId: typeof messageId === "number" ? messageId : undefined,
    };
  }

  const msg = u.message ?? u.edited_message;
  if (msg && typeof msg === "object") {
    const m = msg as Record<string, any>;
    if (typeof m.text !== "string") return null;
    const chatId = m.chat?.id;
    if (chatId == null) return null;
    const replyToMessageId = m.reply_to_message?.message_id;
    return {
      kind: "message",
      updateId,
      chatId: String(chatId),
      text: m.text,
      replyToText: typeof m.reply_to_message?.text === "string" ? m.reply_to_message.text : undefined,
      replyToMessageId: typeof replyToMessageId === "number" ? replyToMessageId : undefined,
    };
  }

  return null;
}

export interface Route {
  sessionId: string;
  value: string;
  /** Set for inline-button presses so the loop can dismiss the spinner. */
  callbackId?: string;
  /** The bot's question message to delete once the answer is delivered. */
  deleteMessageId?: number;
  /** When set, send this text back to the chat instead of routing to a session. */
  replyText?: string;
}

/**
 * Parse a `/orc <project> <message>` command (optionally `/orc@botname …`).
 * Returns the project token and the message, or null when the text is not a
 * well-formed `/orc` command.
 */
export function parseOrcCommand(
  text: string | undefined | null,
): { project: string; message: string } | null {
  if (!text) return null;
  const m = /^\/orc(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/.exec(text.trim());
  if (!m) return null;
  return { project: m[1], message: m[2].trim() };
}

/** Whether the text begins with an `/orc` command (well-formed or not). */
function isOrcCommand(text: string): boolean {
  return /^\/orc(?:@\w+)?(?:\s|$)/.test(text.trim());
}

/**
 * Decide where an update goes — pure. Foreign chats are ignored. A `/orc` command
 * routes to the named project's orchestrator (via `resolveOrc`); a text reply
 * recovers its session from the quoted message's `ao:session=` tag; a button
 * press carries the session in its callback data.
 */
export function decideRoute(
  parsed: ParsedUpdate,
  expectedChatId?: string,
  resolveOrc?: OrcResolver,
): Route | null {
  if (parsed.kind === "callback") {
    if (expectedChatId && parsed.chatId && parsed.chatId !== expectedChatId) return null;
    const target = parseCallbackData(parsed.data);
    if (!target) return null;
    return {
      sessionId: target.sessionId,
      value: target.value,
      callbackId: parsed.callbackId,
      deleteMessageId: parsed.messageId,
    };
  }

  // message
  if (expectedChatId && parsed.chatId !== expectedChatId) return null;

  // `/orc <project> <text>` — message a project's orchestrator first (not a reply).
  if (isOrcCommand(parsed.text)) {
    if (!resolveOrc) return null;
    const orc = parseOrcCommand(parsed.text);
    if (orc) {
      const { sessionId, available } = resolveOrc(orc.project);
      if (sessionId) return { sessionId, value: orc.message };
      return {
        sessionId: "",
        value: "",
        replyText: `Unknown project "${orc.project}". Available: ${available.join(", ")}`,
      };
    }
    // `/orc` with no/insufficient arguments → usage hint + project list.
    const { available } = resolveOrc("");
    return {
      sessionId: "",
      value: "",
      replyText: `Usage: /orc <project> <message>\nAvailable: ${available.join(", ")}`,
    };
  }

  const sessionId = parseSessionTag(parsed.replyToText);
  if (!sessionId) return null; // not a reply to a tagged message → unroutable
  const value = parsed.text.trim();
  if (!value) return null;
  return { sessionId, value, deleteMessageId: parsed.replyToMessageId };
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

/** Delete a message (the answered question). Best-effort — errors are swallowed. */
async function deleteMessage(botToken: string, chatId: string, messageId: number): Promise<void> {
  try {
    await fetch(`${API_BASE}/bot${botToken}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
  } catch {
    /* best effort */
  }
}

/** Send plain text back to the chat (used for `/orc` feedback). Best-effort. */
async function sendMessage(botToken: string, chatId: string, text: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
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
  // Re-read the projects registry on each `/orc` so newly-added projects resolve
  // without restarting the listener.
  const resolveOrc: OrcResolver = (project) => buildOrcResolver(readProjectsRegistry())(project);
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
        const route = decideRoute(parsed, chatId, resolveOrc);
        if (!route) continue;

        // Feedback path (unknown project / usage): reply in-chat, don't route.
        if (route.replyText) {
          await sendMessage(botToken, chatId, route.replyText);
          continue;
        }

        const ok = await sendToSession(route.sessionId, route.value, ao);
        console.error(
          `[telegram-listener] ${ok ? "delivered" : "FAILED"} → ${route.sessionId}: ${route.value.slice(0, 80)}`,
        );
        if (route.callbackId) await answerCallback(botToken, route.callbackId);
        // Once the answer is delivered, dismiss the bot's question message.
        if (ok && route.deleteMessageId) await deleteMessage(botToken, chatId, route.deleteMessageId);
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
