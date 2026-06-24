import {
  getNotificationDataV3,
  type OrchestratorEvent,
  type NotifyAction,
  type EventPriority,
  type NotificationDataV3,
} from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Telegram Bot API limits
// ---------------------------------------------------------------------------

/** Max characters in a Telegram message body (`sendMessage` text). */
export const TELEGRAM_MESSAGE_MAX = 4096;
/** Max bytes in inline-button `callback_data`. */
export const TELEGRAM_CALLBACK_DATA_MAX = 64;
/** Max characters shown on an inline button. */
export const TELEGRAM_BUTTON_LABEL_MAX = 64;

// ---------------------------------------------------------------------------
// Session ↔ message correlation
//
// AO has no inbound channel, so the notifier embeds the session id in every
// outbound message. Telegram echoes the original text back on a reply
// (`message.reply_to_message.text`) and on a button press the session travels in
// `callback_query.data`, so the listener can always recover which session a human
// reply belongs to — with zero shared mutable state between the two processes.
// ---------------------------------------------------------------------------

/** Visible footer marker carrying the session id, e.g. `ao:session=mae-10`. */
const SESSION_TAG_RE = /ao:session=([A-Za-z0-9._\-:]+)/;

export function encodeSessionTag(sessionId: string): string {
  return `ao:session=${sessionId}`;
}

/** Recover a session id from any text that contains a session tag, or null. */
export function parseSessionTag(text: string | undefined | null): string | null {
  if (!text) return null;
  const m = SESSION_TAG_RE.exec(text);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Inline-button callback data
//
// Encodes the target session + the value to deliver, kept within Telegram's
// 64-byte callback_data budget. Long option values are truncated (the full,
// arbitrary-length answer path is the text reply, which has no such limit).
// ---------------------------------------------------------------------------

const CALLBACK_PREFIX = "ao";
const CALLBACK_SEP = ""; // unit separator — never appears in session ids / labels

export function encodeCallbackData(sessionId: string, value: string): string {
  const head = `${CALLBACK_PREFIX}${CALLBACK_SEP}${sessionId}${CALLBACK_SEP}`;
  const budget = TELEGRAM_CALLBACK_DATA_MAX - byteLength(head);
  return head + truncateToBytes(value, Math.max(0, budget));
}

export interface CallbackTarget {
  sessionId: string;
  value: string;
}

export function parseCallbackData(data: string | undefined | null): CallbackTarget | null {
  if (!data) return null;
  const parts = data.split(CALLBACK_SEP);
  if (parts.length < 3 || parts[0] !== CALLBACK_PREFIX) return null;
  const sessionId = parts[1];
  if (!sessionId) return null;
  // The value may itself have contained a separator (it shouldn't, but be safe).
  const value = parts.slice(2).join(CALLBACK_SEP);
  return { sessionId, value };
}

// ---------------------------------------------------------------------------
// Pending-choice callback data
//
// Fuzzy `/orc` candidate buttons must deliver the human's ORIGINAL message,
// which can be arbitrarily long — too long for the 64-byte callback_data. So the
// button carries only a short opaque id; the listener keeps the (session, text)
// pair in memory and looks it up on press. A distinct prefix keeps these disjoint
// from the direct-value callbacks above (`ao` vs `aop`).
// ---------------------------------------------------------------------------

const PENDING_PREFIX = "aop";

export function encodePendingCallback(id: string): string {
  return `${PENDING_PREFIX}${CALLBACK_SEP}${id}`;
}

/** Recover a pending-choice id from callback data, or null if it isn't one. */
export function parsePendingCallback(data: string | undefined | null): string | null {
  if (!data) return null;
  const parts = data.split(CALLBACK_SEP);
  if (parts.length !== 2 || parts[0] !== PENDING_PREFIX) return null;
  return parts[1] || null;
}

// ---------------------------------------------------------------------------
// Choice options
//
// `session.needs_input` carries no structured options today (see
// notification-data.ts), but a reaction or a future event may attach an
// `options` / `choices` array. When present we render inline buttons; otherwise
// the human just replies with free text.
// ---------------------------------------------------------------------------

export interface ChoiceOption {
  label: string;
  /** Value delivered to the agent on selection (defaults to the label). */
  value: string;
}

/** Extract choice options from an event's data, tolerating several shapes. */
export function extractOptions(event: OrchestratorEvent): ChoiceOption[] {
  const data = event.data as Record<string, unknown> | undefined;
  const raw = data?.options ?? data?.choices;
  if (!Array.isArray(raw)) return [];
  const options: ChoiceOption[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (item.trim()) options.push({ label: item, value: item });
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const label = typeof o.label === "string" ? o.label : typeof o.text === "string" ? o.text : undefined;
      const value =
        typeof o.value === "string" ? o.value : typeof o.id === "string" ? o.id : label;
      if (label && value) options.push({ label, value });
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Message formatting (plain text — no parse_mode, so nothing needs escaping)
// ---------------------------------------------------------------------------

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: "\u{1F6A8}", // 🚨
  action: "\u{1F449}", // 👉
  warning: "\u{26A0}\u{FE0F}", // ⚠️
  info: "\u{2139}\u{FE0F}", // ℹ️
};

function titleCaseStatus(value: string): string {
  return value
    .split(/[_\s.-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function eventTitle(event: OrchestratorEvent, data: NotificationDataV3 | null): string {
  const pr = data?.subject.pr;
  switch (event.type) {
    case "ci.failing":
      return pr ? `CI failing on PR #${pr.number}` : "CI failing";
    case "merge.ready":
      return pr ? `PR #${pr.number} ready to merge` : "Pull request ready to merge";
    case "review.changes_requested":
      return pr ? `Changes requested on PR #${pr.number}` : "Review changes requested";
    case "session.needs_input":
      return "Agent needs input";
    case "session.stuck":
      return "Agent may be stuck";
    case "session.killed":
    case "session.exited":
      return "Agent exited";
    case "pr.closed":
      return pr ? `PR #${pr.number} closed` : "Pull request closed";
    case "summary.all_complete":
      return "All sessions complete";
    default:
      return titleCaseStatus(event.type);
  }
}

/** Whether a reply makes sense for this event (so we show the reply hint). */
export function isInteractive(event: OrchestratorEvent): boolean {
  return (
    event.type === "session.needs_input" ||
    event.type === "session.stuck" ||
    event.priority === "urgent" ||
    event.priority === "action"
  );
}

/**
 * Build the plain-text message body for an event, including the session tag so a
 * human reply can be routed back. Truncated to Telegram's message limit.
 */
export function buildMessageText(event: OrchestratorEvent): string {
  const data = getNotificationDataV3(event.data);
  const emoji = PRIORITY_EMOJI[event.priority] ?? PRIORITY_EMOJI.info;
  const title = eventTitle(event, data);
  const lines: string[] = [`${emoji} ${title}`, ""];

  if (event.message) lines.push(event.message);

  const meta: string[] = [];
  if (event.projectId) meta.push(`project ${event.projectId}`);
  if (event.sessionId) meta.push(`session ${event.sessionId}`);
  const pr = data?.subject.pr;
  if (pr) meta.push(`PR #${pr.number}`);
  if (meta.length) lines.push("", meta.join(" · "));

  if (pr?.url) lines.push(pr.url);

  // Trailing machine-readable footer for inbound correlation + a human hint.
  lines.push("");
  if (isInteractive(event)) {
    lines.push(`↩️ Reply to this message to answer · ${encodeSessionTag(event.sessionId)}`);
  } else {
    lines.push(encodeSessionTag(event.sessionId));
  }

  return truncate(lines.join("\n"), TELEGRAM_MESSAGE_MAX);
}

/**
 * Inline keyboard rows from explicit choice options and/or NotifyActions.
 * Option/callback buttons deliver a value into the session; URL actions open links.
 */
export function buildInlineKeyboard(
  sessionId: string,
  options: ChoiceOption[],
  actions?: NotifyAction[],
): { inline_keyboard: TelegramInlineButton[][] } | undefined {
  const rows: TelegramInlineButton[][] = [];

  for (const opt of options.slice(0, 8)) {
    rows.push([
      {
        text: truncate(opt.label, TELEGRAM_BUTTON_LABEL_MAX),
        callback_data: encodeCallbackData(sessionId, opt.value),
      },
    ]);
  }

  const urlRow: TelegramInlineButton[] = [];
  for (const action of actions ?? []) {
    if (action.url && /^https?:\/\//.test(action.url)) {
      urlRow.push({ text: truncate(action.label, TELEGRAM_BUTTON_LABEL_MAX), url: action.url });
    }
  }
  if (urlRow.length) rows.push(urlRow.slice(0, 4));

  return rows.length ? { inline_keyboard: rows } : undefined;
}

export interface TelegramInlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

// ---------------------------------------------------------------------------
// small string utilities
// ---------------------------------------------------------------------------

export function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

/**
 * Split text into chunks each at most `limit` characters, preferring to break on a
 * newline (then a space) near the limit so lines/words are not sliced mid-token. A
 * single token longer than the limit is hard-cut. Used to forward an orchestrator
 * reply that exceeds Telegram's 4096-char per-message cap across several messages.
 *
 * Never returns an empty array for non-empty input. `limit <= 0` yields the whole
 * string as one chunk (degenerate caller bug — better than an infinite loop).
 */
export function splitForTelegram(text: string, limit = TELEGRAM_MESSAGE_MAX): string[] {
  if (limit <= 0 || text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  const minChunk = Math.floor(limit / 2); // avoid breaking so early we make tiny chunks
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < minChunk) cut = rest.lastIndexOf(" ", limit);
    if (cut < minChunk) cut = limit; // no usable boundary → hard cut at the limit
    chunks.push(rest.slice(0, cut));
    // Drop the whitespace we broke on so it doesn't lead the next chunk.
    rest = rest.slice(cut).replace(/^[\n ]+/, "");
  }
  if (rest.length) chunks.push(rest);
  return chunks.length ? chunks : [text];
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Truncate a string so its UTF-8 byte length never exceeds `maxBytes`. */
function truncateToBytes(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s;
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const b = byteLength(ch);
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return out;
}
