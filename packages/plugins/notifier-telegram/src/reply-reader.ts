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
 * the injected message triggered and forward it once that turn completes.
 * If the orchestrator is on a non-SDK runtime the log is absent and reads return
 * null (graceful no-op).
 *
 * CURSOR — why physical append order, NOT `seq`/`turn`. Both `seq` and `turn` are
 * per-RUN counters: on every `session/resumed`/`session/init` (engine restart, app
 * relaunch, conversation resume) they RESET to 0/1 and climb again, so the log is a
 * concatenation of segments where the same `seq`/`turn` value recurs many times. A
 * cursor based on `max(seq)` breaks the instant the session resumes: a freshly
 * injected message gets a small `seq` that never exceeds the pre-resume maximum, so
 * the reply is silently never forwarded — and matching reply text by `turn` would
 * splice together answers from different segments. The append order of the NDJSON
 * file IS monotonic (it is append-only), so we cursor on the event COUNT and scope a
 * reply to the contiguous segment that follows the inject (bounded by the next
 * user/input or a session boundary). This survives any number of resumes.
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
 * Number of events currently in the session's log — a physical-position cursor
 * captured at delivery time so {@link readReplyAfter} only considers events
 * appended AFTER the injected message. Append order is monotonic even across
 * session resumes (unlike `seq`), so this is resume-proof. Returns 0 when the log
 * doesn't exist yet (fresh / non-SDK runtime).
 */
export function snapshotReplyCursor(sessionId: string, env: EnvLike = process.env): number {
  return readEvents(sessionId, env).length;
}

/**
 * Is this event a session-segment boundary (resume/init/end)? A reply must not
 * be read across one — both the assistant text and the run counters restart there.
 */
function isSegmentBoundary(e: NormalizedEvent): boolean {
  return e.type === "session";
}

/** Is this event the echo of an injected user message (a new turn's start)? */
function isUserInput(e: NormalizedEvent): boolean {
  return e.type === "user" && e.subtype === "input";
}

/**
 * Recover the orchestrator's reply to a message injected after `sinceIndex` (an
 * event count from {@link snapshotReplyCursor}): the assistant text of the FIRST
 * `user/input` appended after that cursor, returned only once that turn has
 * completed (a `result` event follows it within the same segment). Returns null
 * while the reply is still streaming or absent.
 *
 * The reply window is scoped by PHYSICAL POSITION — from the inject up to the next
 * `user/input` or a session boundary — so a `seq`/`turn` reset on resume can never
 * cause text from another segment to leak in. Tool-use round-trips stay within the
 * window, so the concatenated text is the full answer including post-tool prose.
 * Returned in full; the listener chunks it across Telegram messages (a reply can
 * exceed the Bot API's 4096-char per-message limit).
 */
export function readReplyAfter(
  sessionId: string,
  sinceIndex: number,
  env: EnvLike = process.env,
): string | null {
  const events = readEvents(sessionId, env);
  // Tolerate a negative legacy cursor by clamping to 0 (consider the whole log).
  const start = Math.max(0, sinceIndex);
  if (events.length <= start) return null; // nothing appended since the snapshot

  // The injected message is the first user/input after the snapshot.
  let injectAt = -1;
  for (let i = start; i < events.length; i++) {
    if (isUserInput(events[i])) {
      injectAt = i;
      break;
    }
  }
  if (injectAt === -1) return null; // our message has not been echoed into the log yet

  // Collect the reply that follows, bounded by the next turn or a segment boundary.
  // `result` inside that window means the turn finalized — only then do we forward.
  let complete = false;
  const parts: string[] = [];
  for (let i = injectAt + 1; i < events.length; i++) {
    const e = events[i];
    if (isUserInput(e) || isSegmentBoundary(e)) break;
    if (e.type === "result") {
      complete = true;
      continue;
    }
    if ((e.type === "text-delta" || e.type === "text") && typeof e.text === "string") {
      parts.push(e.text);
    }
  }
  if (!complete) return null;

  const text = parts.join("").trim();
  return text || null;
}
