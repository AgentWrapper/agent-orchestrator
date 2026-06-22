/**
 * protocol.ts — transport for the live, subscribable event stream.
 *
 * Wire format is line-delimited JSON (NDJSON) over a Unix domain socket (POSIX)
 * or a named pipe (Windows), bidirectional. One complete JSON object per line.
 *
 * Snapshot -> live handshake (host -> subscriber, in order on connect):
 *   1. { type: "hello", role: "host", session_id, seq_head }
 *   2. replay of every buffered NormalizedEvent so far (one line each)
 *   3. { type: "snapshot-complete", seq }
 *   4. live NormalizedEvents forever
 *
 * Control lines (subscriber -> host); a pure subscriber sends none:
 *   { cmd: "send", text }                          push a user turn
 *   { cmd: "status" }                  -> reply    { type: "status", ... }
 *   { cmd: "output", lines }           -> reply    { type: "output", text }
 *   { cmd: "permission", request_id, behavior, message? }   answer a request
 *   { cmd: "kill" }                                graceful host shutdown
 *
 * Paths are derived from the AO session id (known at create() time), NOT the
 * provider session id (which is unknown until the first turn produces init).
 */

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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
    socket: socketAddress(aoSessionId, base),
  };
}

/**
 * Socket address. On Windows we use a named pipe (no path-length limit). On
 * POSIX we keep the socket inside the session dir, but Unix socket paths are
 * capped (~104 bytes on macOS); if the in-dir path is too long we fall back to
 * a short name under the OS temp dir.
 */
export function socketAddress(aoSessionId: string, base: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ao-sdk-${aoSessionId}`;
  }
  const inDir = join(base, "host.sock");
  if (Buffer.byteLength(inDir) <= 100) return inDir;
  return join(tmpdir(), `ao-sdk-${aoSessionId}.sock`);
}

/** Persisted session metadata. */
export interface SessionInfo {
  aoSessionId: string;
  sdkSessionId: string | null;
  model: string | null;
  hostPid: number;
  startedAt: string;
  resumedFrom: string | null;
}

// ---------------------------------------------------------------------------
// Control / handshake message types (distinct from NormalizedEvent)
// ---------------------------------------------------------------------------

export interface HelloMessage {
  type: "hello";
  role: "host";
  session_id: string | null;
  seq_head: number;
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
