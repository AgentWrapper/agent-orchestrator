/**
 * protocol.ts — transport for the live, subscribable event stream.
 *
 * Wire format is line-delimited JSON (NDJSON) over a Unix domain socket (POSIX)
 * or a named pipe (Windows), bidirectional. One complete JSON object per line.
 *
 * Snapshot -> live handshake (host -> subscriber, in order on connect):
 *   1. { type: "hello", role: "host", session_id, seq_head, epoch, resumed, resumed_from }
 *   2. replay of every buffered NormalizedEvent so far (one line each)
 *   3. { type: "snapshot-complete", seq }
 *   4. live NormalizedEvents forever
 *
 * `epoch` advances per host instance so a subscriber detects a resurrected host
 * (seq/turn reset to 0) deterministically instead of guessing from seq_head.
 *
 * Control lines (subscriber -> host); a pure subscriber sends none:
 *   { cmd: "subscribe", tail_events?, since_seq? }  OPT-IN bounded snapshot (see below)
 *   { cmd: "send", text }                          push a user turn
 *   { cmd: "status" }                  -> reply    { type: "status", ... }
 *   { cmd: "output", lines }           -> reply    { type: "output", text }
 *   { cmd: "permission", request_id, behavior, message? }   answer a request
 *   { cmd: "kill" }                                graceful host shutdown
 *
 * Bounded subscribe (#1, additive + opt-in): on connect the host holds the
 * snapshot for a short grace window. A client that sends `subscribe` first gets
 * only the requested tail (`tail_events`) / events after `since_seq`; the rest it
 * reads from the durable log. A client that sends NO subscribe command (any old
 * client) gets the FULL snapshot after the grace — exactly the prior behavior.
 *
 * Paths are derived from the AO session id (known at create() time), NOT the
 * provider session id (which is unknown until the first turn produces init).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { NormalizedEvent } from "./event-schema.js";

export const ONLY_SESSION_ID = /^[A-Za-z0-9_-]+$/;

export function assertValidSessionId(id: string): void {
  if (!ONLY_SESSION_ID.test(id)) {
    throw new Error(`Invalid session id "${id}": must match ${ONLY_SESSION_ID}`);
  }
}

/** Environment slice used for path resolution. */
type EnvLike = Record<string, string | undefined>;

/**
 * Root directory for all runtime-sdk session state. Resolved from `env` so the
 * plugin (which spawns the host) and the host itself derive identical paths even
 * when AO_SDK_HOME / AO_HOME are passed per-session via config.environment.
 */
export function sdkHome(env: EnvLike = process.env): string {
  if (env.AO_SDK_HOME) return env.AO_SDK_HOME;
  const aoHome = env.AO_HOME || join(homedir(), ".agent-orchestrator");
  return join(aoHome, "runtime-sdk");
}

export interface SessionPaths {
  /** Per-session base directory. */
  base: string;
  /** Append-only NDJSON event log (full history incl. resumes). */
  eventLog: string;
  /** Small JSON file mirroring { aoSessionId, sdkSessionId, ... }. */
  sessionInfo: string;
  /** Live socket / named pipe address. */
  socket: string;
}

export function sessionPaths(aoSessionId: string, env: EnvLike = process.env): SessionPaths {
  assertValidSessionId(aoSessionId);
  const base = join(sdkHome(env), aoSessionId);
  return {
    base,
    eventLog: join(base, "events.ndjson"),
    sessionInfo: join(base, "session.json"),
    socket: socketAddress(aoSessionId, env),
  };
}

/**
 * Short directory for live sockets. Deterministic and independent of $TMPDIR so
 * the host and a separate subscriber (e.g. Maestro) compute the SAME path
 * without sharing a temp dir. Override with AO_SDK_SOCK_DIR (set it identically
 * on both sides if their $HOME differs, e.g. an app sandbox).
 */
export function socketRoot(env: EnvLike = process.env): string {
  return env.AO_SDK_SOCK_DIR || join(homedir(), ".ao-sdk");
}

/**
 * 16-hex socket name component, sha256(aoSessionId) truncated. Keeps the POSIX
 * socket path well under the ~104-byte sockaddr_un limit regardless of how long
 * the AO session id is, and is computed identically on both sides.
 */
export function socketNameComponent(aoSessionId: string): string {
  return createHash("sha256").update(aoSessionId).digest("hex").slice(0, 16);
}

/**
 * Deterministic socket address. POSIX: `<socketRoot>/<hash16>.sock`. Windows:
 * named pipe `\\.\pipe\ao-sdk-<hash16>` (no length limit, hashed for parity).
 * No conditional fallback — both sides derive the identical path.
 */
export function socketAddress(aoSessionId: string, env: EnvLike = process.env): string {
  const name = socketNameComponent(aoSessionId);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ao-sdk-${name}`;
  }
  return join(socketRoot(env), `${name}.sock`);
}

/** Persisted session metadata. */
export interface SessionInfo {
  aoSessionId: string;
  sdkSessionId: string | null;
  model: string | null;
  hostPid: number;
  startedAt: string;
  resumedFrom: string | null;
  /** Host-instance epoch (advances per host process; see HelloMessage.epoch). */
  epoch: number;
}

// ---------------------------------------------------------------------------
// Control / handshake message types (distinct from NormalizedEvent)
// ---------------------------------------------------------------------------

export interface HelloMessage {
  type: "hello";
  role: "host";
  session_id: string | null;
  seq_head: number;
  /**
   * Monotonic host-instance id for this AO session. Advances every time a new
   * host process starts (incl. resume). On a fresh host `seq`/`turn` reset to 0;
   * a subscriber compares `epoch` against the last one it saw to detect the new
   * instance deterministically (no seq_head heuristic).
   */
  epoch: number;
  /** True when this host started by resuming a prior provider session. */
  resumed: boolean;
  /** The provider session id resumed from, or null for a fresh session. */
  resumed_from: string | null;
}
export interface SnapshotCompleteMessage {
  type: "snapshot-complete";
  seq: number;
}
export interface StatusMessage {
  type: "status";
  alive: boolean;
  session_id: string | null;
  seq: number;
  turns: number;
}
export interface OutputMessage {
  type: "output";
  text: string;
}

export type HostMessage =
  | NormalizedEvent
  | HelloMessage
  | SnapshotCompleteMessage
  | StatusMessage
  | OutputMessage;

export type ClientCommand =
  | { cmd: "subscribe"; tail_events?: number; since_seq?: number }
  | { cmd: "send"; text: string }
  | { cmd: "status" }
  | { cmd: "output"; lines?: number }
  | { cmd: "permission"; request_id: string; behavior: "allow" | "deny"; message?: string }
  | { cmd: "kill" };

// ---------------------------------------------------------------------------
// NDJSON line framing
// ---------------------------------------------------------------------------

/** Encode one object as a single NDJSON line (terminated with "\n"). */
export function encodeLine(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

/**
 * Streaming NDJSON parser. Feed arbitrary chunks; receive one parsed object per
 * complete line via the callback. Malformed lines are skipped.
 */
export class LineParser {
  private buf = "";
  private readonly onLine: (obj: unknown) => void;

  constructor(onLine: (obj: unknown) => void) {
    this.onLine = onLine;
  }

  feed(chunk: string | Buffer): void {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim() === "") continue;
      try {
        this.onLine(JSON.parse(line));
      } catch {
        /* skip malformed line */
      }
    }
  }
}
