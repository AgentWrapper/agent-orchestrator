import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  parseSessionTag,
  encodeSessionTag,
  parseCallbackData,
  encodePendingCallback,
  parsePendingCallback,
  truncate,
  splitForTelegram,
  TELEGRAM_BUTTON_LABEL_MAX,
  TELEGRAM_MESSAGE_MAX,
  type CallbackTarget,
} from "./shared.js";
import { snapshotReplyCursor, readReplyAfter } from "./reply-reader.js";

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

/** A fuzzy `/orc` candidate — its orchestrator session plus a button label. */
export interface OrcCandidate {
  sessionId: string;
  label: string;
}

export interface OrcResolution {
  /** Orchestrator session id for an EXACT match, or null. */
  sessionId: string | null;
  /**
   * Fuzzy matches when there is no exact match — rendered as inline buttons so the
   * human can pick. Empty on an exact match or when nothing matches at all.
   */
  candidates?: OrcCandidate[];
  /** Human-facing list of available project names (for feedback messages). */
  available: string[];
}

/** Resolve a `/orc` project token to its orchestrator session, plus the menu. */
export type OrcResolver = (project: string) => OrcResolution;

/** True when `needle`'s chars appear in order within `haystack` (a gap-tolerant match). */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (i < needle.length && ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}

/** Every searchable field of an entry, lower-cased and non-empty. */
function entryFields(entry: ProjectRegistryEntry): string[] {
  return [entry.displayName, entry.sessionPrefix, entry.projectId]
    .filter((f): f is string => !!f)
    .map((f) => f.toLowerCase());
}

/**
 * Fuzzy-match a token against the registry: prefer entries that contain the token
 * as a substring; only if none do, fall back to subsequence matching (so `bosh`
 * still finds `boschcenter.kz`). Routable entries only (need a sessionPrefix).
 */
function findCandidates(token: string, entries: ProjectRegistryEntry[]): ProjectRegistryEntry[] {
  const routable = entries.filter((e) => e.sessionPrefix);
  const substring = routable.filter((e) => entryFields(e).some((f) => f.includes(token)));
  if (substring.length) return substring;
  return routable.filter((e) => entryFields(e).some((f) => isSubsequence(token, f)));
}

/**
 * Build a resolver over a registry snapshot. An EXACT (case-insensitive, trimmed)
 * match on displayName, sessionPrefix, or projectId resolves directly to
 * `<sessionPrefix>-orchestrator`. Otherwise the resolver returns fuzzy candidates
 * for the caller to surface as buttons.
 */
export function buildOrcResolver(entries: ProjectRegistryEntry[]): OrcResolver {
  const available = entries.map(projectLabel).filter(Boolean);
  return (project: string): OrcResolution => {
    const token = project.trim().toLowerCase();
    if (!token) return { sessionId: null, candidates: [], available };

    const exact = entries.find(
      (e) =>
        e.displayName?.toLowerCase() === token ||
        e.sessionPrefix?.toLowerCase() === token ||
        e.projectId.toLowerCase() === token,
    );
    if (exact) {
      const sessionId = exact.sessionPrefix ? `${exact.sessionPrefix}-orchestrator` : null;
      return { sessionId, candidates: [], available };
    }

    const candidates: OrcCandidate[] = findCandidates(token, entries).map((e) => ({
      sessionId: `${e.sessionPrefix}-orchestrator`,
      label: projectLabel(e),
    }));
    return { sessionId: null, candidates, available };
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
}

export interface ParsedCallback {
  kind: "callback";
  updateId: number;
  chatId?: string;
  callbackId: string;
  data: string;
}

export type ParsedUpdate = ParsedMessage | ParsedCallback;

/** Minimal shape of the raw Telegram update fields parseUpdate reads. */
interface RawTelegramChat {
  id?: string | number | null;
}
interface RawTelegramMessage {
  text?: unknown;
  chat?: RawTelegramChat;
  reply_to_message?: { text?: unknown };
}
interface RawTelegramUpdate {
  update_id?: unknown;
  callback_query?: { id?: unknown; data?: unknown; message?: RawTelegramMessage };
  message?: RawTelegramMessage;
  edited_message?: RawTelegramMessage;
}

/** Normalise a raw Telegram update into the parts we route on, or null. */
export function parseUpdate(update: unknown): ParsedUpdate | null {
  if (!update || typeof update !== "object") return null;
  const u = update as RawTelegramUpdate;
  const updateId = typeof u.update_id === "number" ? u.update_id : -1;

  if (u.callback_query && typeof u.callback_query === "object") {
    const cq = u.callback_query;
    if (typeof cq.id !== "string" || typeof cq.data !== "string") return null;
    const chatId = cq.message?.chat?.id;
    return {
      kind: "callback",
      updateId,
      chatId: chatId !== undefined && chatId !== null ? String(chatId) : undefined,
      callbackId: cq.id,
      data: cq.data,
    };
  }

  const msg = u.message ?? u.edited_message;
  if (msg && typeof msg === "object") {
    const m = msg;
    if (typeof m.text !== "string") return null;
    const chatId = m.chat?.id;
    if (chatId === undefined || chatId === null) return null;
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
  /** When set, send this text back to the chat instead of routing to a session. */
  replyText?: string;
  /**
   * When set, reply with inline buttons for these fuzzy `/orc` candidates. Pressing
   * one delivers `replyButtonsValue` (the human's original message) to its session.
   */
  replyButtons?: OrcCandidate[];
  /** The original `/orc` message to deliver when a candidate button is pressed. */
  replyButtonsValue?: string;
}

// ---------------------------------------------------------------------------
// Pending fuzzy-choice store
//
// A fuzzy `/orc` reply renders one button per candidate. Each button must deliver
// the human's ORIGINAL message — which can be longer than callback_data allows —
// to a DIFFERENT orchestrator. So we stash each (session, text) pair here under a
// short id, put the id in the button's callback_data, and look it up on press.
// `take` is one-shot (consumes on read); a small cap bounds memory if a prompt is
// never answered (the listener can outlive the daemon).
// ---------------------------------------------------------------------------

export class PendingChoices {
  private readonly map = new Map<string, CallbackTarget>();
  constructor(private readonly max = 500) {}

  /** Stash a choice and return its short id (12 hex chars). */
  put(choice: CallbackTarget): string {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    const id = randomBytes(6).toString("hex");
    this.map.set(id, choice);
    return id;
  }

  /** Look up and consume a choice by id, or null if unknown/already taken. */
  take(id: string): CallbackTarget | null {
    const choice = this.map.get(id);
    if (choice) this.map.delete(id);
    return choice ?? null;
  }
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
  resolvePending?: (id: string) => CallbackTarget | null,
): Route | null {
  if (parsed.kind === "callback") {
    if (expectedChatId && parsed.chatId && parsed.chatId !== expectedChatId) return null;
    // A fuzzy-choice button carries only a short id; recover its (session, text)
    // from the pending store. A stale/expired id (resolver returns null) is dropped.
    const pendingId = parsePendingCallback(parsed.data);
    const target = pendingId ? resolvePending?.(pendingId) ?? null : parseCallbackData(parsed.data);
    if (!target) return null;
    return {
      sessionId: target.sessionId,
      value: target.value,
      callbackId: parsed.callbackId,
    };
  }

  // message
  if (expectedChatId && parsed.chatId !== expectedChatId) return null;

  // `/orc <project> <text>` — message a project's orchestrator first (not a reply).
  if (isOrcCommand(parsed.text)) {
    if (!resolveOrc) return null;
    const orc = parseOrcCommand(parsed.text);
    if (orc) {
      const { sessionId, candidates = [], available } = resolveOrc(orc.project);
      // Exact match → deliver straight to the orchestrator (as before).
      if (sessionId) return { sessionId, value: orc.message };
      // Fuzzy matches → let the human pick which project via inline buttons.
      if (candidates.length) {
        return { sessionId: "", value: "", replyButtons: candidates, replyButtonsValue: orc.message };
      }
      // Nothing matched → the available-projects menu (as before).
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

/** Cap on how many messages a single forwarded reply may fan out into. */
const MAX_REPLY_CHUNKS = 8;

/**
 * Forward an orchestrator reply back to the chat, split across messages when it
 * exceeds Telegram's per-message limit (a long answer would otherwise make
 * sendMessage fail outright). The session tag rides the LAST chunk so a human
 * reply threads back to the session; a multi-part reply is numbered. A reply that
 * would exceed MAX_REPLY_CHUNKS messages is capped with an in-app pointer rather
 * than flooding the chat. Best-effort (each chunk via sendMessage).
 */
async function forwardReply(
  botToken: string,
  chatId: string,
  sessionId: string,
  reply: string,
): Promise<void> {
  const tag = `\n\n${encodeSessionTag(sessionId)}`;
  // Reserve room in every chunk for the part header + the tag + the overflow note,
  // so the final assembled message never crosses the hard limit.
  const budget = Math.max(1, TELEGRAM_MESSAGE_MAX - tag.length - 64);
  let chunks = splitForTelegram(reply, budget);
  let overflow = false;
  if (chunks.length > MAX_REPLY_CHUNKS) {
    chunks = chunks.slice(0, MAX_REPLY_CHUNKS);
    overflow = true;
  }
  const total = chunks.length;
  for (let i = 0; i < total; i++) {
    const isLast = i === total - 1;
    const header = total > 1 ? `(${i + 1}/${total})\n` : "";
    const note = isLast && overflow ? "\n\n… (полностью в приложении)" : "";
    const footer = isLast ? tag : "";
    await sendMessage(botToken, chatId, `${header}${chunks[i]}${note}${footer}`);
  }
}

/**
 * Reply with one inline button per fuzzy `/orc` candidate. Each button's
 * callback_data carries only a short pending id (so the original `value` —
 * possibly long — is never truncated); pressing it routes that value to the
 * chosen project's orchestrator via the normal callback path. Best-effort.
 */
async function sendButtonChoices(
  botToken: string,
  chatId: string,
  candidates: OrcCandidate[],
  value: string,
  pending: PendingChoices,
): Promise<void> {
  const inline_keyboard = candidates.slice(0, 8).map((c) => {
    const id = pending.put({ sessionId: c.sessionId, value });
    return [{ text: truncate(c.label, TELEGRAM_BUTTON_LABEL_MAX), callback_data: encodePendingCallback(id) }];
  });
  try {
    await fetch(`${API_BASE}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "Which project?",
        reply_markup: { inline_keyboard },
        disable_web_page_preview: true,
      }),
    });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Single-instance lock + owner-aware eviction
// ---------------------------------------------------------------------------
//
// The inbound listener is spawned *detached* so it can route replies even while
// the daemon is busy — but that also means it OUTLIVES the daemon. When a new
// daemon boots after a restart (most painfully, an engine upgrade) it would find
// the *previous* daemon's listener still holding the lock and, under the old
// logic, decline to start its own. The stale listener (old engine code, e.g.
// missing `/orc` / answered-question deletion) then keeps running until someone
// restarts it by hand.
//
// Fix: stamp the lock with the identity of the engine BUILD that owns the listener.
// A later daemon compares — a listener from a *different build* (an upgrade) is
// evicted and replaced with one running the current code; a listener from the *same
// build* (a plain restart / crash-loop) is recognised as ours and left alone.
//
// Owner identity is the build, NOT `pid:random`. The old `pid:random` id differed on
// every restart, so each fresh daemon treated the previous daemon's listener as
// foreign and evicted+spawned its own. In a crash-restart cycle those fire-and-forget
// evictions raced and *several* listeners piled up (the incident this fixes). A
// build-stable id collapses that to one: same build → skip, changed build → evict.

/**
 * Stable identity of the engine BUILD running this listener: the listener module's
 * absolute path plus its mtime. Identical across plain restarts of the same build
 * (so a restart recognises an already-running listener as its own and never spawns a
 * parallel one) but different after a redeploy (a new build bumps the file mtime), so
 * an engine upgrade still evicts the stale-code listener and takes over.
 */
function engineOwnerId(): string {
  try {
    const self = fileURLToPath(import.meta.url);
    const mtime = Math.floor(statSync(self).mtimeMs);
    return `engine:${self}:${mtime}`;
  } catch {
    // Module path unreadable (should not happen in a real install): degrade to a
    // per-process id rather than throw — never worse than the old behaviour.
    return `engine:${process.pid}:${randomBytes(4).toString("hex")}`;
  }
}

/** Stable identity of THIS engine build for the lifetime of the process. */
const OWNER_ID = engineOwnerId();

/** Env var by which a daemon hands its identity down to the listener it spawns. */
const OWNER_ENV = "AO_TELEGRAM_OWNER_ID";

/**
 * The owner the listener should record. When spawned by a daemon it adopts that
 * daemon's identity (so the daemon recognises the listener as its own); run
 * standalone (`ao-telegram-listen`) it owns itself.
 */
function listenerOwnerId(): string {
  return process.env[OWNER_ENV] || OWNER_ID;
}

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

export interface ListenerLock {
  listenerPid: number;
  /** Identity of the daemon that owns this listener; absent in legacy locks. */
  ownerId?: string;
}

/**
 * Read and parse the listener lock. Tolerates the legacy bare-pid format written
 * by older engines: such a lock has no owner, so it is treated as belonging to an
 * *unknown* (previous) daemon and gets evicted by the current one — which is
 * exactly the upgrade case we are fixing.
 */
export function readListenerLock(path = lockPath()): ListenerLock | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return { listenerPid: parseInt(raw, 10) }; // legacy bare pid
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const listenerPid = typeof obj.listenerPid === "number" ? obj.listenerPid : NaN;
    if (Number.isNaN(listenerPid)) return null;
    return {
      listenerPid,
      ownerId: typeof obj.ownerId === "string" ? obj.ownerId : undefined,
    };
  } catch {
    return null;
  }
}

function writeListenerLock(path: string, listenerPid: number, ownerId: string): void {
  writeFileSync(path, JSON.stringify({ listenerPid, ownerId }));
}

export type ListenerAction = "spawn" | "skip" | "evict";

/**
 * Pure decision for the daemon side (`maybeStartListener`): given the current lock,
 * our identity, and a liveness probe, decide what to do.
 *   - "skip"  → a listener WE own is already live → do nothing (single-instance).
 *   - "evict" → a live listener owned by a *different* daemon (or a legacy/no-owner
 *               lock) → stop it and spawn ours so the current code takes over.
 *   - "spawn" → no live listener → just spawn ours.
 */
export function decideListenerAction(
  lock: ListenerLock | null,
  myOwnerId: string,
  alive: (pid: number) => boolean,
): ListenerAction {
  if (!lock || !alive(lock.listenerPid)) return "spawn";
  return lock.ownerId === myOwnerId ? "skip" : "evict";
}

/**
 * Acquire the listener lock for THIS process.
 *   - A live listener of the *same* owner already holds it → refuse (`false`): two
 *     listeners for one daemon would double-poll Telegram.
 *   - A live listener of a *different* owner holds it → take over: the daemon that
 *     spawned us has already signalled the old one, so we overwrite the lock. This
 *     also tolerates the handoff race where the evicted listener has not finished
 *     exiting yet — we claim the lock rather than bailing on its lingering pid.
 *   - Otherwise (free / dead / legacy holder) → claim it.
 * `alive` is injectable for tests; production uses the real pid probe.
 */
export function acquireListenerLock(
  path = lockPath(),
  alive: (pid: number) => boolean = isPidAlive,
): boolean {
  try {
    const mine = listenerOwnerId();
    const existing = readListenerLock(path);
    if (
      existing &&
      existing.listenerPid !== process.pid &&
      alive(existing.listenerPid) &&
      existing.ownerId === mine
    ) {
      return false; // a sibling listener of the same daemon is already live
    }
    writeListenerLock(path, process.pid, mine);
    return true;
  } catch {
    // If we can't use a lockfile, allow running (better to listen than not).
    return true;
  }
}

function releaseListenerLock(path = lockPath()): void {
  try {
    const existing = readListenerLock(path);
    if (existing && existing.listenerPid === process.pid) unlinkSync(path);
  } catch {
    /* ignore */
  }
}

/** Block the current thread for `ms` without busy-spinning (Atomics-based). */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable — skip the wait (best effort) */
  }
}

/** Injectable side-effects for evictStrayListener (real signals/sleeps in prod). */
export interface EvictDeps {
  kill?: (pid: number, signal: NodeJS.Signals | number) => void;
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => void;
}

/**
 * Synchronously stop a stray listener and WAIT until it is gone before returning, so
 * the caller never spawns a replacement while the old one is still draining its 25s
 * long-poll (the race that let listeners pile up). SIGTERM first — the listener's
 * handler calls process.exit, so it normally dies at once — then a bounded liveness
 * poll, then SIGKILL as a last resort. Bounded throughout so a daemon boot can never
 * hang on it. Works off a bare pid, so it kills a stray held by a legacy / owner-less
 * / stale lock just the same. Deps are injectable for tests (no real signals/sleeps).
 */
export function evictStrayListener(pid: number, deps: EvictDeps = {}): void {
  const kill = deps.kill ?? ((p, s) => process.kill(p, s));
  const alive = deps.alive ?? isPidAlive;
  const sleep = deps.sleep ?? sleepSync;
  // Never signal an invalid pid or ourselves.
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  if (!alive(pid)) return;
  try {
    kill(pid, "SIGTERM");
  } catch {
    /* already gone or not ours */
  }
  // Up to ~2s for a graceful exit.
  for (let i = 0; i < 40 && alive(pid); i++) sleep(50);
  if (!alive(pid)) return;
  // Still alive (stuck mid-syscall, or deaf to SIGTERM) → force it.
  try {
    kill(pid, "SIGKILL");
  } catch {
    /* nothing more we can do */
  }
  for (let i = 0; i < 20 && alive(pid); i++) sleep(50);
}

// ---------------------------------------------------------------------------
// Long-poll offset persistence + skip-to-latest
// ---------------------------------------------------------------------------
//
// `getUpdates` returns every still-unconfirmed update from `offset` onward. A fresh
// listener that started from `offset = 0` re-read the whole backlog and re-injected
// old `/orc` commands — catastrophic in a crash-loop, where the daemon kept
// respawning listeners that each replayed the queue. We now persist the last
// confirmed offset and resume from it; on a first run (no file) we skip PAST the
// backlog so queued commands are dropped, not replayed.

/** Path of the persisted long-poll offset (last confirmed update_id + 1). */
function offsetPath(): string {
  return join(stateRoot(), "telegram-listener.offset");
}

/**
 * Read the persisted long-poll offset. A missing, empty, or corrupt file yields null
 * (the caller treats that as a first run → skip-to-latest). Never throws.
 */
export function readPersistedOffset(path = offsetPath()): number | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8").trim();
    if (!/^\d+$/.test(raw)) return null;
    const n = parseInt(raw, 10);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** Atomically persist the long-poll offset (temp file + rename). Best-effort. */
export function writePersistedOffset(offset: number, path = offsetPath()): void {
  try {
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, String(offset));
    renameSync(tmp, path);
  } catch {
    /* best-effort; a write failure just means a future restart re-skips the backlog */
  }
}

/**
 * Probe Telegram for the id of the most recent pending update WITHOUT routing it, by
 * asking for only the last update (`offset=-1`). Returns that update_id, or null when
 * the queue is empty / the call fails. Used on a first run to jump PAST any backlog so
 * a freshly-(re)started listener never replays old `/orc` commands.
 */
export async function probeLatestUpdateId(
  botToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<number | null> {
  try {
    const res = await fetchFn(getUpdatesUrl(botToken, -1, 0));
    const json = (await res.json()) as { ok?: boolean; result?: unknown[] };
    if (!json.ok || !Array.isArray(json.result) || json.result.length === 0) return null;
    let maxId: number | null = null;
    for (const raw of json.result) {
      const id = parseUpdate(raw)?.updateId;
      if (typeof id === "number" && id >= 0 && (maxId === null || id > maxId)) maxId = id;
    }
    return maxId;
  } catch {
    return null;
  }
}

/** Injectable inputs for resolveStartOffset (real fs + Telegram probe in prod). */
export interface StartOffsetDeps {
  readPersisted?: (path?: string) => number | null;
  probeLatest?: () => Promise<number | null>;
}

/**
 * Decide the offset the long-poll loop should start from.
 *   - A persisted offset (a previous run advanced past it) → resume there exactly,
 *     no probe, no replay.
 *   - No / corrupt persisted offset (first run after install, or a crash that never
 *     persisted) → skip-to-latest: `lastUpdateId + 1`, so the next confirming poll
 *     makes Telegram drop the whole backlog and we never re-inject old commands.
 *   - Empty queue / probe failure → 0 (nothing to skip; a later real update is new).
 * `seeded` marks the skip path so the caller can persist it (durable skip).
 */
export async function resolveStartOffset(
  deps: StartOffsetDeps = {},
): Promise<{ offset: number; seeded: boolean }> {
  const readPersisted = deps.readPersisted ?? readPersistedOffset;
  const persisted = readPersisted();
  if (persisted !== null) return { offset: persisted, seeded: false };
  const last = deps.probeLatest ? await deps.probeLatest() : null;
  if (last !== null) return { offset: last + 1, seeded: true };
  return { offset: 0, seeded: false };
}

// ---------------------------------------------------------------------------
// The long-poll loop
// ---------------------------------------------------------------------------

const POLL_TIMEOUT_SEC = 25;
// While awaiting an orchestrator reply to forward, poll on a short cycle so the
// answer reaches the chat within a couple of seconds instead of up to 25s.
const REPLY_POLL_TIMEOUT_SEC = 2;
// Stop waiting to forward a reply after this long (orchestrator never answered).
const REPLY_WAIT_MS = 10 * 60_000;

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
  // Holds the (session, original-text) behind each fuzzy-choice button until pressed.
  const pending = new PendingChoices();
  const resolvePending = (id: string): CallbackTarget | null => pending.take(id);
  // Outbound `/orc` replies: after injecting a message into a session, remember
  // the chat + the transcript length at inject time (a resume-proof position cursor)
  // so we can forward the orchestrator's answer back.
  // Keyed by sessionId — a newer inject supersedes an older pending wait.
  const pendingReplies = new Map<string, { chatId: string; sinceIndex: number; deadlineMs: number }>();
  let running = true;
  const stop = () => {
    running = false;
    releaseListenerLock();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  // Resume from the persisted offset, or — on a first run / after a crash that never
  // persisted — skip PAST any queued backlog so we never replay old `/orc` commands.
  const start = await resolveStartOffset({ probeLatest: () => probeLatestUpdateId(botToken) });
  let offset = start.offset;
  if (start.seeded) writePersistedOffset(offset);
  console.error(
    `[telegram-listener] listening (chat ${chatId}) from offset ${offset}${start.seeded ? " (skipped backlog)" : ""}`,
  );
  let backoff = 1000;

  while (running) {
    try {
      const pollTimeout = pendingReplies.size > 0 ? REPLY_POLL_TIMEOUT_SEC : POLL_TIMEOUT_SEC;
      const res = await fetch(getUpdatesUrl(botToken, offset, pollTimeout));
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
        if (parsed) {
          const next = Math.max(offset, parsed.updateId + 1);
          if (next !== offset) {
            offset = next;
            // Persist atomically so a restart resumes here instead of replaying.
            writePersistedOffset(offset);
          }
        }
        if (!parsed) continue;
        const route = decideRoute(parsed, chatId, resolveOrc, resolvePending);
        if (!route) continue;

        // Fuzzy `/orc`: offer the matching projects as buttons (no route yet).
        if (route.replyButtons) {
          await sendButtonChoices(botToken, chatId, route.replyButtons, route.replyButtonsValue ?? "", pending);
          continue;
        }

        // Feedback path (unknown project / usage): reply in-chat, don't route.
        if (route.replyText) {
          await sendMessage(botToken, chatId, route.replyText);
          continue;
        }

        // Snapshot the transcript length BEFORE delivery so the reply we later
        // forward is the one THIS message triggers, not an earlier turn. A length
        // (event count) is used rather than a seq because seq resets on resume.
        const replyCursor = snapshotReplyCursor(route.sessionId);
        const ok = await sendToSession(route.sessionId, route.value, ao);
        console.error(
          `[telegram-listener] ${ok ? "delivered" : "FAILED"} → ${route.sessionId}: ${route.value.slice(0, 80)}`,
        );
        if (ok) {
          pendingReplies.set(route.sessionId, {
            chatId,
            sinceIndex: replyCursor,
            deadlineMs: Date.now() + REPLY_WAIT_MS,
          });
        }
        // Acknowledge a button press ("Sent ✅"); the question message itself is
        // kept so the chat preserves the full history of asks and answers.
        if (route.callbackId) await answerCallback(botToken, route.callbackId);
      }

      // Forward any orchestrator replies that completed since their inject, and
      // drop waits that have timed out. Runs every poll cycle (short cycle while
      // a reply is pending — see pollTimeout above). The session tag lets the
      // human reply in-thread, exactly like a lifecycle notification.
      for (const [sid, p] of pendingReplies) {
        const reply = readReplyAfter(sid, p.sinceIndex);
        if (reply) {
          await forwardReply(botToken, p.chatId, sid, reply);
          pendingReplies.delete(sid);
          console.error(`[telegram-listener] forwarded reply ← ${sid}`);
        } else if (Date.now() > p.deadlineMs) {
          pendingReplies.delete(sid);
          console.error(`[telegram-listener] gave up waiting for reply ← ${sid}`);
        }
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
 * under a test runner, listening is opted out, or credentials are missing.
 *
 * A live listener owned by THIS daemon is left alone (single-instance). A live
 * listener owned by a *different/previous* daemon — or a legacy lock with no owner
 * — is evicted first, so after any restart (notably an engine upgrade) the listener
 * runs the current code rather than the stale detached process. Idempotent.
 */
export function maybeStartListener(config?: Record<string, unknown>): void {
  if (process.env.VITEST || process.env.AO_TELEGRAM_NO_LISTEN) return;
  if (config?.listen === false) return;
  const botToken = config?.botToken;
  const chatId = config?.chatId;
  if (!botToken || chatId === undefined || chatId === null || chatId === "") return;

  let existing: ListenerLock | null = null;
  try {
    existing = readListenerLock();
  } catch {
    /* unreadable lock — treat as none and spawn */
  }
  const action = decideListenerAction(existing, OWNER_ID, isPidAlive);
  if (action === "skip") return; // our own listener is already running
  if (action === "evict" && existing) {
    // A listener from a *different build* (an engine upgrade) — or a legacy / owner-less
    // / stale lock — holds the lock. Stop it SYNCHRONOUSLY and wait for it to actually
    // die before we spawn ours, so a fast restart cycle can never leave two listeners
    // polling at once. evictStrayListener works off the bare pid, so it also clears a
    // stray whose owning daemon is long dead (the exact state this fix migrates from).
    evictStrayListener(existing.listenerPid);
  }

  try {
    const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    // Let the child reach `ao` even when it's not on PATH (bundled engine).
    childEnv.AO_NODE ??= process.execPath;
    const argv1 = process.argv[1];
    if (argv1 && /\.(c|m)?js$/.test(argv1) && existsSync(argv1)) childEnv.AO_CLI ??= argv1;
    if (typeof config?.configPath === "string") childEnv.AO_CONFIG_PATH ??= config.configPath;
    // Stamp the listener with OUR identity (overwrite, not ??=, so each daemon owns
    // the listener it spawns) — a later daemon uses this to recognise its own.
    childEnv[OWNER_ENV] = OWNER_ID;

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
