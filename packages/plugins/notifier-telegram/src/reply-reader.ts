/**
 * Outbound `/orc` reply capture (approach A — listener-side).
 *
 * When the listener delivers a message into the orchestrator session, the
 * orchestrator's free-text answer is otherwise lost — the notifier only sends
 * lifecycle events. Here we recover that answer from the orchestrator's
 * normalized runtime-sdk event log so the listener can send it back to the chat.
 *
 * In the headless/Maestro build the orchestrator runs on runtime-sdk (claude-code
 * defaults to the SDK runtime), which appends a normalized NDJSON transcript to
 * `<sdkHome>/<sessionId>/events.ndjson`. We read the assistant text of the turn
 * the injected message triggered, using the per-turn `turn` stamp so a reply is
 * never confused with a still-streaming earlier turn. If the orchestrator is on
 * a non-SDK runtime the log is absent and reads return null (graceful no-op).
 *
 * NOTE: the path resolution below MUST stay in sync with runtime-sdk's
 * `sdkHome()` (packages/plugins/runtime-sdk/src/protocol.ts). It is duplicated
 * rather than imported to avoid a plugin→plugin runtime dependency. The exact
 * path contract (default home, AO_HOME, AO_SDK_HOME precedence) is pinned by
 * unit tests on BOTH sides — `sdkEventLogPath` in reply-reader.test.ts here and
 * runtime-sdk's protocol.test.ts — so drift in either copy surfaces as a test
 * failure rather than a silently broken reply path.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Max length of a reply we forward to Telegram (Bot API hard-caps at 4096). */
const TELEGRAM_TEXT_MAX = 3900;

type EnvLike = Record<string, string | undefined>;

interface NormalizedEvent {
  seq?: number;
  turn?: number;
  type?: string;
  subtype?: string;
  text?: string;
}

/**
 * Mirror of runtime-sdk `sdkHome()` + the per-session event-log path. Exported
 * so the path contract can be pinned by a unit test (see the NOTE above).
 */
export function sdkEventLogPath(sessionId: string, env: EnvLike = process.env): string {
  const root = env.AO_SDK_HOME
    ? env.AO_SDK_HOME
    : join(env.AO_HOME || join(env.HOME || homedir(), ".agent-orchestrator"), "runtime-sdk");
  return join(root, sessionId, "events.ndjson");
}

function readEvents(sessionId: string, env: EnvLike): NormalizedEvent[] {
  const path = sdkEventLogPath(sessionId, env);
  if (!existsSync(path)) return [];
  const events: NormalizedEvent[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as NormalizedEvent);
    } catch {
      // Skip a malformed/partial trailing line — the next read picks it up.
    }
  }
  return events;
}

/**
 * Highest `seq` currently in the session's event log, captured at delivery time
 * so {@link readReplyAfter} only considers events written after the injected
 * message. Returns -1 when the log doesn't exist yet (fresh / non-SDK runtime).
 */
export function snapshotReplyCursor(sessionId: string, env: EnvLike = process.env): number {
  let max = -1;
  for (const e of readEvents(sessionId, env)) {
    if (typeof e.seq === "number" && e.seq > max) max = e.seq;
  }
  return max;
}

/**
 * Recover the orchestrator's reply to a message injected after `sinceSeq`:
 * the assistant text of the FIRST turn whose `user/input` echo appears after
 * `sinceSeq`, returned only once that turn has completed (its `result` event is
 * present). Returns null while the reply is still streaming or absent.
 *
 * Tool-use round-trips stay within the same turn, so the concatenated text is
 * the full answer including any post-tool prose. Truncated to Telegram's limit.
 */
export function readReplyAfter(
  sessionId: string,
  sinceSeq: number,
  env: EnvLike = process.env,
): string | null {
  const events = readEvents(sessionId, env);
  if (events.length === 0) return null;

  const inject = events.find(
    (e) => (e.seq ?? -1) > sinceSeq && e.type === "user" && e.subtype === "input",
  );
  if (!inject || typeof inject.turn !== "number") return null;
  const turn = inject.turn;

  // Only forward once the turn is finalized — otherwise we'd send a partial reply.
  const complete = events.some((e) => e.type === "result" && e.turn === turn);
  if (!complete) return null;

  const text = events
    .filter(
      (e) =>
        e.turn === turn &&
        (e.type === "text-delta" || e.type === "text") &&
        typeof e.text === "string",
    )
    .map((e) => e.text as string)
    .join("")
    .trim();

  if (!text) return null;
  return text.length > TELEGRAM_TEXT_MAX ? `${text.slice(0, TELEGRAM_TEXT_MAX)}\n…(truncated)` : text;
}
