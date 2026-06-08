/**
 * Multiplexed WebSocket server for terminal multiplexing.
 * Manages multiple terminal connections over a single persistent WebSocket.
 *
 * Session updates are delivered via polling of Next.js /api/sessions/patches
 * every 3s, then broadcast to all subscribed clients via WebSocket.
 */

import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { type Socket, connect as netConnect } from "node:net";
import { dirname, join } from "node:path";
import {
  DEFAULT_DASHBOARD_NOTIFICATION_LIMIT,
  getEnvDefaults,
  getDashboardNotificationStorePath,
  getNodePtyPrebuildsSubdir,
  isWindows,
  loadConfig,
  normalizeDashboardNotificationLimit,
  recordActivityEvent,
  readDashboardNotificationsFromFile,
  type DashboardNotificationRecord,
} from "@aoagents/ao-core";
import {
  findTmux,
  resolveTmuxSession,
  resolvePipePath,
  tmuxHasSession,
  validateSessionId,
} from "./tmux-utils.js";

// These types mirror src/lib/mux-protocol.ts exactly.
// tsconfig.server.json constrains rootDir to "server/", so we cannot import
// across the boundary. Keep both in sync when updating the protocol.

// ── Client → Server ──
type ClientMessage =
  | { ch: "terminal"; id: string; type: "data"; data: string; projectId?: string }
  | { ch: "terminal"; id: string; type: "resize"; cols: number; rows: number; projectId?: string }
  | { ch: "terminal"; id: string; type: "open"; projectId?: string; tmuxName?: string }
  | { ch: "terminal"; id: string; type: "close"; projectId?: string }
  | { ch: "system"; type: "ping" }
  | { ch: "subscribe"; topics: Array<"sessions" | "notifications"> };

// ── Server → Client ──
type ServerMessage =
  | { ch: "terminal"; id: string; type: "data"; data: string; projectId?: string }
  | { ch: "terminal"; id: string; type: "exited"; code: number; projectId?: string }
  | { ch: "terminal"; id: string; type: "opened"; projectId?: string }
  | { ch: "terminal"; id: string; type: "error"; message: string; projectId?: string }
  | { ch: "sessions"; type: "snapshot"; sessions: SessionPatch[] }
  | { ch: "sessions"; type: "error"; error: string }
  | {
      ch: "notifications";
      type: "snapshot" | "append";
      notifications: DashboardNotificationRecord[];
      limit: number;
    }
  | { ch: "notifications"; type: "error"; error: string }
  | { ch: "system"; type: "pong" }
  | { ch: "system"; type: "error"; message: string };

// Mirrors AttentionLevel in src/lib/types.ts — keep in sync.
type AttentionLevel = "merge" | "action" | "respond" | "review" | "pending" | "working" | "done";

interface SessionPatch {
  id: string;
  status: string;
  activity: string | null;
  attentionLevel: AttentionLevel;
  lastActivityAt: string;
}

/**
 * Manages polling of session patches from Next.js /api/sessions/patches.
 * Broadcasts to all subscribed callbacks.
 * Lazily starts polling on first subscriber, stops when the last one leaves.
 */
export class SessionBroadcaster {
  private subscribers = new Set<(sessions: SessionPatch[]) => void>();
  private errorSubscribers = new Set<(error: string) => void>();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  // Tracks the last fetch outcome so we only emit ui.session_broadcast_failed on
  // the healthy → failing transition (not every 3s during an outage).
  private lastFetchOk = true;
  private readonly baseUrl: string;

  constructor(nextPort: string) {
    this.baseUrl = `http://localhost:${nextPort}`;
  }

  /**
   * Subscribe to session patches and errors. Returns an unsubscribe function.
   * Sends an immediate snapshot to the new subscriber, then polling updates.
   */
  subscribe(
    callback: (sessions: SessionPatch[]) => void,
    onError?: (error: string) => void,
  ): () => void {
    const wasEmpty = this.subscribers.size === 0;
    this.subscribers.add(callback);
    if (onError) this.errorSubscribers.add(onError);

    // Immediately send a one-off snapshot to just this new subscriber
    void this.fetchSnapshot().then((result) => {
      if (result.sessions && this.subscribers.has(callback)) {
        try {
          callback(result.sessions);
        } catch {
          // Isolate subscriber errors so one bad subscriber doesn't break others
        }
      } else if (result.error && onError && this.errorSubscribers.has(onError)) {
        try {
          onError(result.error);
        } catch {
          // Isolate subscriber errors
        }
      }
    });

    // Start polling if this is the first subscriber
    if (wasEmpty) {
      this.intervalId = setInterval(() => {
        if (this.polling) return;
        this.polling = true;
        void this.fetchSnapshot()
          .then((result) => {
            if (result.sessions && this.intervalId !== null) this.broadcast(result.sessions);
            else if (result.error && this.intervalId !== null) this.broadcastError(result.error);
          })
          .finally(() => {
            this.polling = false;
          });
      }, 3000);
    }

    return () => {
      this.subscribers.delete(callback);
      if (onError) this.errorSubscribers.delete(onError);
      if (this.subscribers.size === 0) {
        this.disconnect();
      }
    };
  }

  private broadcast(sessions: SessionPatch[]): void {
    for (const callback of this.subscribers) {
      try {
        callback(sessions);
      } catch (err) {
        console.error("[MuxServer] Session broadcast subscriber threw:", err);
      }
    }
  }

  private broadcastError(error: string): void {
    for (const callback of this.errorSubscribers) {
      try {
        callback(error);
      } catch (err) {
        console.error("[MuxServer] Session error subscriber threw:", err);
      }
    }
  }

  /** One-shot HTTP fetch of the current session list. */
  private async fetchSnapshot(): Promise<{
    sessions: SessionPatch[] | null;
    error: string | null;
  }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions/patches`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        const msg = `Session fetch failed: HTTP ${res.status}`;
        console.warn(`[SessionBroadcaster] ${msg}`);
        this.recordFetchFailure(msg, { httpStatus: res.status });
        return { sessions: null, error: msg };
      }
      const data = (await res.json()) as { sessions?: SessionPatch[] };
      this.lastFetchOk = true;
      return { sessions: data.sessions ?? null, error: null };
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[SessionBroadcaster] fetchSnapshot error:", msg);
      this.recordFetchFailure(msg);
      return { sessions: null, error: msg };
    }
  }

  /**
   * Emit ui.session_broadcast_failed once per healthy→failing transition.
   * The broadcaster polls every 3s; emitting on every failure during a long
   * outage would flood the events table (~20/min). Recovery resets the flag.
   */
  private recordFetchFailure(message: string, extra?: Record<string, unknown>): void {
    if (!this.lastFetchOk) return;
    this.lastFetchOk = false;
    recordActivityEvent({
      source: "ui",
      kind: "ui.session_broadcast_failed",
      level: "warn",
      summary: `session broadcaster fetch failed: ${message}`,
      data: {
        url: `${this.baseUrl}/api/sessions/patches`,
        errorMessage: message,
        ...extra,
      },
    });
  }

  private disconnect(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

function notificationKey(record: DashboardNotificationRecord): string {
  return `${record.id}:${record.receivedAt}`;
}

function readDashboardLimit(configPath: string | undefined): number {
  if (!configPath) return DEFAULT_DASHBOARD_NOTIFICATION_LIMIT;
  try {
    const config = loadConfig(configPath);
    const dashboardConfig = config.notifiers?.["dashboard"];
    return normalizeDashboardNotificationLimit(dashboardConfig?.["limit"]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[NotificationBroadcaster] Could not read dashboard notifier limit:", message);
    return DEFAULT_DASHBOARD_NOTIFICATION_LIMIT;
  }
}

/**
 * Polls the dashboard notification JSONL store and broadcasts changes to mux
 * subscribers. The store is config-scoped and survives dashboard reloads.
 */
export class NotificationBroadcaster {
  private subscribers = new Set<
    (
      notifications: DashboardNotificationRecord[],
      type: "snapshot" | "append",
      limit: number,
    ) => void
  >();
  private errorSubscribers = new Set<(error: string) => void>();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastRecords: DashboardNotificationRecord[] = [];
  private readonly configPath: string | undefined;
  private readonly storePath: string | null;

  constructor(configPath = process.env["AO_CONFIG_PATH"]) {
    this.configPath = configPath;
    this.storePath = configPath ? getDashboardNotificationStorePath(configPath) : null;
  }

  subscribe(
    callback: (
      notifications: DashboardNotificationRecord[],
      type: "snapshot" | "append",
      limit: number,
    ) => void,
    onError?: (error: string) => void,
  ): () => void {
    const wasEmpty = this.subscribers.size === 0;
    this.subscribers.add(callback);
    if (onError) this.errorSubscribers.add(onError);

    const snapshot = this.fetchSnapshot();
    if (wasEmpty) {
      this.lastRecords = snapshot.notifications;
    }
    try {
      callback(snapshot.notifications, "snapshot", snapshot.limit);
    } catch {
      // Isolate subscriber errors so one bad socket does not break others.
    }

    if (snapshot.error && onError) {
      try {
        onError(snapshot.error);
      } catch {
        // Isolate subscriber errors.
      }
    }

    if (wasEmpty) {
      this.intervalId = setInterval(() => {
        const result = this.fetchSnapshot();
        if (result.error) {
          this.broadcastError(result.error);
          return;
        }

        const previousKeys = new Set(this.lastRecords.map(notificationKey));
        const appended = result.notifications.filter(
          (record) => !previousKeys.has(notificationKey(record)),
        );
        const trimmed = result.notifications.length < this.lastRecords.length;
        this.lastRecords = result.notifications;

        if (appended.length > 0 && !trimmed) {
          this.broadcast(appended, "append", result.limit);
        } else if (appended.length > 0 || trimmed) {
          this.broadcast(result.notifications, "snapshot", result.limit);
        }
      }, 1000);
    }

    return () => {
      this.subscribers.delete(callback);
      if (onError) this.errorSubscribers.delete(onError);
      if (this.subscribers.size === 0) {
        this.disconnect();
      }
    };
  }

  private fetchSnapshot(): {
    notifications: DashboardNotificationRecord[];
    error: string | null;
    limit: number;
  } {
    const limit = readDashboardLimit(this.configPath);
    if (!this.storePath) return { notifications: [], error: null, limit };

    try {
      return {
        notifications: readDashboardNotificationsFromFile(this.storePath, limit),
        error: null,
        limit,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[NotificationBroadcaster] fetchSnapshot error:", message);
      return { notifications: [], error: message, limit };
    }
  }

  private broadcast(
    notifications: DashboardNotificationRecord[],
    type: "snapshot" | "append",
    limit: number,
  ): void {
    for (const callback of this.subscribers) {
      try {
        callback(notifications, type, limit);
      } catch (err) {
        console.error("[MuxServer] Notification broadcast subscriber threw:", err);
      }
    }
  }

  private broadcastError(error: string): void {
    for (const callback of this.errorSubscribers) {
      try {
        callback(error);
      } catch (err) {
        console.error("[MuxServer] Notification error subscriber threw:", err);
      }
    }
  }

  private disconnect(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

// node-pty is an optionalDependency — load dynamically
/* eslint-disable @typescript-eslint/consistent-type-imports -- node-pty is optional; static import would crash if missing */
type IPty = import("node-pty").IPty;
type PtySpawn = typeof import("node-pty").spawn;
type PtySpawnOptions = Parameters<PtySpawn>[2];
let ptySpawn: PtySpawn | undefined;
/* eslint-enable @typescript-eslint/consistent-type-imports */
const nodePtyRequire = createRequire(import.meta.url);

export function resolveNodePtySpawnHelperPath(): string | null {
  const override = process.env.AO_NODE_PTY_SPAWN_HELPER_PATH;
  if (override) return override;

  try {
    const packageJsonPath = nodePtyRequire.resolve("node-pty/package.json");
    return join(dirname(packageJsonPath), "prebuilds", getNodePtyPrebuildsSubdir(), "spawn-helper");
  } catch {
    return null;
  }
}

function isPosixSpawnpFailure(err: unknown): boolean {
  return err instanceof Error && err.message.includes("posix_spawnp");
}

function repairNodePtySpawnHelper(): string | null {
  if (isWindows()) return null;

  const spawnHelperPath = resolveNodePtySpawnHelperPath();
  if (!spawnHelperPath || !fs.existsSync(spawnHelperPath)) return null;

  fs.chmodSync(spawnHelperPath, 0o755);
  return spawnHelperPath;
}

try {
  const nodePty = await import("node-pty");
  ptySpawn = nodePty.spawn;
} catch (err) {
  console.warn("[MuxServer] node-pty not available — mux server will be disabled.", err);
}

interface ManagedTerminal {
  id: string;
  tmuxSessionId: string;
  pty: IPty | null;
  subscribers: Set<(data: string) => void>;
  exitCallbacks: Set<(exitCode: number) => void>;
  buffer: string[];
  bufferBytes: number;
  reattachAttempts: number;
  ptyLostEmitted: boolean;
  /**
   * Pending grace-period timer that resets reattachAttempts when the
   * currently-attached PTY survives REATTACH_RESET_GRACE_MS. Tracked so
   * cleanup paths (last-subscriber unsubscribe, subsequent re-attach) can
   * clear it and avoid keeping the dead PTY/terminal closure references
   * reachable for up to 5 s after teardown.
   */
  resetTimer?: ReturnType<typeof setTimeout>;
}

const RING_BUFFER_MAX = 50 * 1024; // 50KB max per terminal
const WS_BUFFER_HIGH_WATERMARK = 64 * 1024; // 64KB
const MAX_REATTACH_ATTEMPTS = 3;
/**
 * Grace period a freshly-attached PTY must survive before its successful
 * attach is allowed to reset the re-attach counter. Prevents tight crash
 * loops (e.g. attaching to a tmux session that no longer exists) from
 * gaming the MAX_REATTACH_ATTEMPTS cap by resetting the counter to 0
 * between every failed attempt.
 *
 * 5 s is comfortably longer than the ~40 ms a doomed `tmux attach-session`
 * takes to exit, while still being short enough that a healthy PTY which
 * crashes hours later gets a fresh retry budget.
 */
const REATTACH_RESET_GRACE_MS = 5_000;

/**
 * TerminalManager manages PTY processes independently of WebSocket connections.
 * A single manager instance is shared across all mux connections.
 */
export class TerminalManager {
  private terminals = new Map<string, ManagedTerminal>();
  private TMUX: string;
  private spawnHelperRepairAttempted = false;

  constructor(tmuxPath?: string) {
    const resolved = tmuxPath ?? findTmux();
    if (!resolved) {
      throw new Error("tmux not available on this platform");
    }
    this.TMUX = resolved;
  }

  private terminalKey(id: string, projectId?: string): string {
    return projectId ? `${projectId}:${id}` : id;
  }

  private spawnTmuxPty(args: string[], options: PtySpawnOptions): IPty {
    if (!ptySpawn) {
      throw new Error("node-pty not available");
    }

    try {
      return ptySpawn(this.TMUX, args, options);
    } catch (err) {
      if (this.spawnHelperRepairAttempted || !isPosixSpawnpFailure(err)) {
        throw err;
      }

      this.spawnHelperRepairAttempted = true;
      try {
        const repairedPath = repairNodePtySpawnHelper();
        if (repairedPath) {
          console.warn(
            `[MuxServer] node-pty posix_spawnp failed; set executable bit on ${repairedPath} and retrying once.`,
          );
        } else {
          console.warn(
            "[MuxServer] node-pty posix_spawnp failed; spawn-helper was not found, retrying once.",
          );
        }
      } catch (repairErr) {
        const message = repairErr instanceof Error ? repairErr.message : String(repairErr);
        console.warn(
          `[MuxServer] node-pty posix_spawnp failed; chmod spawn-helper failed (${message}), retrying once.`,
        );
      }

      return ptySpawn(this.TMUX, args, options);
    }
  }

  /**
   * Open/attach to a terminal. If already open, just return.
   * If has subscribers but PTY crashed, re-attach.
   */
  open(id: string, projectId?: string, tmuxName?: string): string {
    if (!validateSessionId(id)) {
      throw new Error(`Invalid session ID: ${id}`);
    }

    const key = this.terminalKey(id, projectId);
    const existing = this.terminals.get(key);
    const tmuxSessionId =
      tmuxName ??
      existing?.tmuxSessionId ??
      resolveTmuxSession(id, this.TMUX, undefined, undefined, projectId);
    if (!tmuxSessionId) {
      throw new Error(`Session not found: ${id}`);
    }

    // Get or create terminal entry
    let terminal = this.terminals.get(key);
    if (!terminal) {
      terminal = {
        id,
        tmuxSessionId,
        pty: null,
        subscribers: new Set(),
        exitCallbacks: new Set(),
        buffer: [],
        bufferBytes: 0,
        reattachAttempts: 0,
        ptyLostEmitted: false,
      };
      this.terminals.set(key, terminal);
    }

    // If PTY is already attached, we're done
    if (terminal.pty) {
      return tmuxSessionId;
    }

    // tmux 3.4 only honours the `=` exact-match prefix on has-session and
    // attach-session; set-option silently ignores it, so we use the bare id
    // here. The `=`-prefixed form is built below for attach-session.

    // Enable mouse mode
    const mouseProc = spawn(this.TMUX, ["set-option", "-t", tmuxSessionId, "mouse", "on"]);
    mouseProc.on("error", (err) => {
      console.error(`[MuxServer] Failed to set mouse mode for ${tmuxSessionId}:`, err.message);
    });

    // Hide the status bar
    const statusProc = spawn(this.TMUX, ["set-option", "-t", tmuxSessionId, "status", "off"]);
    statusProc.on("error", (err) => {
      console.error(`[MuxServer] Failed to hide status bar for ${tmuxSessionId}:`, err.message);
    });

    // Build environment
    const platformDefaults = getEnvDefaults();
    const homeDir = platformDefaults.HOME;
    const env = {
      HOME: platformDefaults.HOME,
      SHELL: platformDefaults.SHELL,
      USER: platformDefaults.USER,
      PATH: process.env.PATH || platformDefaults.PATH,
      TERM: "xterm-256color",
      LANG: process.env.LANG || "en_US.UTF-8",
      TMPDIR: platformDefaults.TMPDIR,
    };

    // Spawn PTY — use `=`-prefixed exact-match target so we never attach to
    // a session whose name happens to be a prefix of the requested id.
    const exactTmuxTarget = `=${tmuxSessionId}`;
    const pty = this.spawnTmuxPty(["attach-session", "-t", exactTmuxTarget], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: homeDir,
      env,
    });

    terminal.pty = pty;

    // Schedule a grace-period reset of the re-attach counter. We only
    // consider an attach "really successful" if the PTY survives long
    // enough to suggest the underlying tmux session is actually usable.
    // The closure-captured `pty` reference is compared with terminal.pty
    // so a stale timer cannot reset the counter for a PTY that has
    // already exited or been replaced by re-attach. Any previously-
    // scheduled timer (from a now-replaced PTY) is cleared so we don't
    // keep its closure references reachable until the timer fires.
    if (terminal.resetTimer) {
      clearTimeout(terminal.resetTimer);
    }
    terminal.resetTimer = setTimeout(() => {
      terminal.resetTimer = undefined;
      if (terminal.pty === pty) {
        terminal.reattachAttempts = 0;
        terminal.ptyLostEmitted = false;
      }
    }, REATTACH_RESET_GRACE_MS);
    terminal.resetTimer.unref();

    // Wire up data events
    pty.onData((data: string) => {
      // Push to all subscribers — isolate each callback so a throw in one
      // (e.g. a closed ws.send) doesn't abort the loop or skip the buffer.
      for (const callback of terminal.subscribers) {
        try {
          callback(data);
        } catch (err) {
          console.error("[MuxServer] Subscriber callback threw:", err);
        }
      }

      // Append to ring buffer
      terminal.buffer.push(data);
      terminal.bufferBytes += Buffer.byteLength(data, "utf8");

      // Trim buffer if over limit
      while (terminal.bufferBytes > RING_BUFFER_MAX && terminal.buffer.length > 0) {
        const removed = terminal.buffer.shift() ?? "";
        terminal.bufferBytes -= Buffer.byteLength(removed, "utf8");
      }
    });

    // Handle PTY exit
    //
    // Async: the has-session probe shells out via promisified execFile and
    // must be awaited. node-pty fires onExit on the main thread; a sync
    // probe would freeze the entire web server (every WebSocket, HTTP
    // request, in-flight terminal) for up to the subprocess timeout when
    // tmux is slow to respond.
    pty.onExit(async ({ exitCode }) => {
      console.log(`[MuxServer] PTY exited for ${id} with code ${exitCode}`);
      terminal.pty = null;
      let reattachError: string | undefined;

      // Skip the re-attach loop entirely when the underlying tmux session is
      // gone (e.g. user pressed Ctrl-C in the pane and the launch command
      // exited, taking the only window with it). Without this guard we
      // burn three doomed attach-session spawns and emit a noisy
      // "Max re-attach attempts reached" log line for what is actually a
      // clean user-initiated termination — see issue #1756. The
      // MAX_REATTACH_ATTEMPTS bound from #1640 still covers tmux server
      // hiccups where the session does still exist.
      if (terminal.subscribers.size > 0 && !(await tmuxHasSession(this.TMUX, tmuxSessionId))) {
        console.log(`[MuxServer] tmux session ${tmuxSessionId} is gone, not re-attaching`);
        if (terminal.resetTimer) {
          clearTimeout(terminal.resetTimer);
          terminal.resetTimer = undefined;
        }
        if (!terminal.ptyLostEmitted) {
          terminal.ptyLostEmitted = true;
          recordActivityEvent({
            projectId,
            sessionId: id,
            source: "ui",
            kind: "ui.terminal_pty_lost",
            level: "warn",
            summary: `terminal PTY exited (code ${exitCode}) — tmux session gone`,
            data: {
              sessionId: id,
              exitCode,
              reattachAttempts: terminal.reattachAttempts,
              maxReattachAttempts: MAX_REATTACH_ATTEMPTS,
              reattachExhausted: false,
              reattachSkipped: true,
              tmuxSessionPresent: false,
              subscriberCount: terminal.subscribers.size,
            },
          });
        }
        for (const cb of terminal.exitCallbacks) {
          cb(exitCode);
        }
        return;
      }

      // Re-attach if subscribers are still present, up to MAX_REATTACH_ATTEMPTS.
      // The cap prevents an unbounded respawn loop when the PTY crashes immediately
      // after every attach (e.g. resource exhaustion or a broken tmux session).
      // The counter is reset by a delayed timer in open() once the new PTY has
      // survived REATTACH_RESET_GRACE_MS — see the comment on that constant.
      // Resetting here would defeat the cap: when ao stop kills the tmux session
      // out from under a still-subscribed dashboard, attach-session exits ~40 ms
      // after spawn and the loop runs at ~80 spawns/sec, exhausting the system
      // PTY pool in seconds (issue #1639).
      if (terminal.subscribers.size > 0 && terminal.reattachAttempts < MAX_REATTACH_ATTEMPTS) {
        terminal.reattachAttempts += 1;
        console.log(
          `[MuxServer] Re-attaching to ${id} (attempt ${terminal.reattachAttempts}/${MAX_REATTACH_ATTEMPTS})`,
        );
        try {
          this.open(id, projectId, tmuxSessionId);
          if (!terminal.ptyLostEmitted) {
            terminal.ptyLostEmitted = true;
            recordActivityEvent({
              projectId,
              sessionId: id,
              source: "ui",
              kind: "ui.terminal_pty_lost",
              level: "warn",
              summary: `terminal PTY exited (code ${exitCode}) — reattached`,
              data: {
                sessionId: id,
                exitCode,
                reattachAttempts: terminal.reattachAttempts,
                maxReattachAttempts: MAX_REATTACH_ATTEMPTS,
                reattachExhausted: false,
                reattachRecovered: true,
                subscriberCount: terminal.subscribers.size,
              },
            });
          }
          return; // re-attached — don't notify exit
        } catch (err) {
          reattachError = err instanceof Error ? err.message : String(err);
          console.error(`[MuxServer] Failed to re-attach ${id}:`, err);
        }
      } else if (terminal.reattachAttempts >= MAX_REATTACH_ATTEMPTS) {
        console.error(`[MuxServer] Max re-attach attempts reached for ${id}, giving up`);
      }

      // PTY actually died (vs user closed browser): only emit when subscribers
      // are still attached — otherwise the exit is just normal cleanup.
      // Keep this event one-shot for the terminal entry. Clients may re-open
      // the same terminal after a failed reattach; repeated PTY exits should
      // not flood the activity log for the same loss condition.
      if (terminal.subscribers.size > 0 && !terminal.ptyLostEmitted) {
        terminal.ptyLostEmitted = true;
        recordActivityEvent({
          projectId,
          sessionId: id,
          source: "ui",
          kind: "ui.terminal_pty_lost",
          level: "warn",
          summary: `terminal PTY exited (code ${exitCode})${
            terminal.reattachAttempts >= MAX_REATTACH_ATTEMPTS ? " — reattach exhausted" : ""
          }`,
          data: {
            sessionId: id,
            exitCode,
            reattachAttempts: terminal.reattachAttempts,
            maxReattachAttempts: MAX_REATTACH_ATTEMPTS,
            reattachExhausted: terminal.reattachAttempts >= MAX_REATTACH_ATTEMPTS,
            subscriberCount: terminal.subscribers.size,
            ...(reattachError ? { reattachError } : {}),
          },
        });
      }

      // Notify subscribers that the terminal has exited (re-attach failed or no subscribers)
      for (const cb of terminal.exitCallbacks) {
        cb(exitCode);
      }
    });

    console.log(`[MuxServer] Opened terminal ${id} (tmux: ${tmuxSessionId})`);
    return tmuxSessionId;
  }

  /**
   * Write data to the PTY if attached
   */
  write(id: string, data: string, projectId?: string): void {
    const terminal = this.terminals.get(this.terminalKey(id, projectId));
    if (terminal?.pty) {
      terminal.pty.write(data);
    }
  }

  /**
   * Resize the PTY if attached
   */
  resize(id: string, cols: number, rows: number, projectId?: string): void {
    const terminal = this.terminals.get(this.terminalKey(id, projectId));
    if (terminal?.pty) {
      terminal.pty.resize(cols, rows);
    }
  }

  /**
   * Subscribe to terminal data. Returns unsubscribe function.
   * Automatically opens the terminal if needed.
   * @param onExit - called when the PTY exits and cannot be re-attached
   */
  subscribe(
    id: string,
    projectId: string | undefined,
    callback: (data: string) => void,
    onExit?: (exitCode: number) => void,
  ): () => void {
    // Ensure terminal is open
    this.open(id, projectId);
    const key = this.terminalKey(id, projectId);
    const terminal = this.terminals.get(key);
    if (!terminal) {
      throw new Error(`Failed to open terminal: ${id}`);
    }

    // Add subscriber
    terminal.subscribers.add(callback);
    if (onExit) terminal.exitCallbacks.add(onExit);

    // Return unsubscribe function
    return () => {
      terminal.subscribers.delete(callback);
      if (onExit) terminal.exitCallbacks.delete(onExit);
      // Kill PTY and clean up when the last subscriber leaves
      if (terminal.subscribers.size === 0) {
        if (terminal.resetTimer) {
          clearTimeout(terminal.resetTimer);
          terminal.resetTimer = undefined;
        }
        if (terminal.pty) {
          terminal.pty.kill();
          terminal.pty = null;
        }
        this.terminals.delete(key);
      }
    };
  }

  /**
   * Get buffered data for a terminal
   */
  getBuffer(id: string, projectId?: string): string {
    const terminal = this.terminals.get(this.terminalKey(id, projectId));
    if (!terminal) return "";
    return terminal.buffer.join("");
  }
}

// ── Windows Pipe Relay (extracted for testability) ──

const intentionalWinPipeCloses = new WeakSet<Socket>();

/** Minimal WebSocket-like interface for the pipe relay handler */
export interface WsSink {
  send(data: string): void;
  readonly readyState: number;
}

/** Dependencies injected into the pipe relay handler */
export interface PipeRelayDeps {
  connect: (path: string) => Socket;
  resolvePipePath: (id: string, projectId?: string) => string | null;
}

/**
 * Handle a Windows terminal message by relaying through named pipes.
 * Extracted from the WebSocket connection handler for testability.
 */
export function handleWindowsPipeMessage(
  msg: {
    id: string;
    type: string;
    data?: string;
    cols?: number;
    rows?: number;
    projectId?: string;
  },
  ws: WsSink,
  winPipes: Map<string, Socket>,
  winPipeBuffers: Map<string, Buffer>,
  deps: PipeRelayDeps,
): void {
  const WS_OPEN = 1; // WebSocket.OPEN
  const { id, type, projectId } = msg;
  // MuxProvider keys subscribers under `${projectId}:${id}` when projectId is
  // provided, so every outbound terminal message must echo projectId back —
  // otherwise the client routes by id alone and the subscriber bucket
  // mismatches, leaving the xterm pane blank on /projects/[id]/sessions/[id].
  const echo = projectId ? { projectId } : {};
  // Project-scoped pipe-map key: matches the Unix `subscriptionKey` shape so
  // two projects sharing a sessionId on the same mux connection don't collide
  // on the same socket/buffer entry.
  const pipeKey = projectId ? `${projectId}:${id}` : id;

  // The Unix path validates inside TerminalManager.open(). The Windows pipe
  // relay bypasses TerminalManager entirely, so validate here too — `id`
  // becomes a map key and is constructed into a pipe path downstream.
  if (!validateSessionId(id)) {
    if (ws.readyState === WS_OPEN) {
      ws.send(
        JSON.stringify({
          ch: "terminal",
          id,
          type: "error",
          message: "invalid session id",
          ...echo,
        }),
      );
    }
    return;
  }

  if (type === "open") {
    if (winPipes.has(pipeKey)) {
      ws.send(JSON.stringify({ ch: "terminal", id, type: "opened", ...echo }));
    } else {
      const pipePath = deps.resolvePipePath(id, projectId);
      if (!pipePath) {
        throw new Error(`No PTY host pipe found for session ${id}`);
      }
      const pipeSocket = deps.connect(pipePath);
      winPipes.set(pipeKey, pipeSocket);
      winPipeBuffers.set(pipeKey, Buffer.alloc(0));
      let ptyLostEmitted = false;
      const recordWindowsPtyLost = (
        reason: "pipe_closed" | "host_not_alive" | "pipe_error",
        extra?: Record<string, unknown>,
      ): void => {
        if (ptyLostEmitted || ws.readyState !== WS_OPEN) return;
        ptyLostEmitted = true;
        recordActivityEvent({
          projectId,
          sessionId: id,
          source: "ui",
          kind: "ui.terminal_pty_lost",
          level: "warn",
          summary:
            reason === "host_not_alive"
              ? `terminal PTY host reported not alive for ${id}`
              : reason === "pipe_error"
                ? `terminal PTY host pipe errored for ${id}`
                : `terminal PTY host pipe closed for ${id}`,
          data: {
            sessionId: id,
            transport: "windows_pipe",
            reason,
            ...extra,
          },
        });
      };

      pipeSocket.on("error", (err) => {
        recordWindowsPtyLost("pipe_error", { errorMessage: err.message });
        winPipes.delete(pipeKey);
        winPipeBuffers.delete(pipeKey);
        pipeSocket.destroy();
        if (ws.readyState === WS_OPEN) {
          ws.send(
            JSON.stringify({
              ch: "terminal",
              id,
              type: "error",
              message: `PTY host not available: ${err.message}`,
              ...echo,
            }),
          );
        }
      });

      pipeSocket.on("connect", () => {
        if (ws.readyState === WS_OPEN) {
          ws.send(JSON.stringify({ ch: "terminal", id, type: "opened", ...echo }));
        }

        pipeSocket.on("data", (chunk: Buffer) => {
          const existing = winPipeBuffers.get(pipeKey) ?? Buffer.alloc(0);
          let buf = Buffer.concat([existing, chunk]);
          winPipeBuffers.set(pipeKey, buf);

          while (buf.length >= 5) {
            const msgType = buf.readUInt8(0);
            const length = buf.readUInt32BE(1);
            if (buf.length < 5 + length) break;
            const payload = buf.subarray(5, 5 + length);
            buf = buf.subarray(5 + length);
            winPipeBuffers.set(pipeKey, buf);

            if (msgType === 0x01 && ws.readyState === WS_OPEN) {
              ws.send(
                JSON.stringify({
                  ch: "terminal",
                  id,
                  type: "data",
                  data: payload.toString("utf-8"),
                  ...echo,
                }),
              );
            }
            if (msgType === 0x07) {
              try {
                const status = JSON.parse(payload.toString("utf-8")) as { alive: boolean };
                if (!status.alive && ws.readyState === WS_OPEN) {
                  recordWindowsPtyLost("host_not_alive");
                  ws.send(JSON.stringify({ ch: "terminal", id, type: "exited", code: 0, ...echo }));
                }
              } catch {
                /* ignore parse errors */
              }
            }
          }
        });

        pipeSocket.on("close", () => {
          winPipes.delete(pipeKey);
          winPipeBuffers.delete(pipeKey);
          const intentionalClose = intentionalWinPipeCloses.delete(pipeSocket);
          if (ws.readyState === WS_OPEN) {
            if (!intentionalClose) {
              recordWindowsPtyLost("pipe_closed");
            }
            ws.send(JSON.stringify({ ch: "terminal", id, type: "exited", code: 0, ...echo }));
          }
        });
      });
    }
  } else if (type === "data" && msg.data !== undefined) {
    const pipeSocket = winPipes.get(pipeKey);
    if (pipeSocket) {
      const inputBuf = Buffer.from(msg.data, "utf-8");
      const header = Buffer.alloc(5);
      header.writeUInt8(0x02, 0);
      header.writeUInt32BE(inputBuf.length, 1);
      pipeSocket.write(Buffer.concat([header, inputBuf]));
    }
  } else if (type === "resize" && msg.cols !== undefined && msg.rows !== undefined) {
    const pipeSocket = winPipes.get(pipeKey);
    if (pipeSocket) {
      const resizePayload = Buffer.from(JSON.stringify({ cols: msg.cols, rows: msg.rows }));
      const header = Buffer.alloc(5);
      header.writeUInt8(0x03, 0);
      header.writeUInt32BE(resizePayload.length, 1);
      pipeSocket.write(Buffer.concat([header, resizePayload]));
    }
  } else if (type === "close") {
    const pipeSocket = winPipes.get(pipeKey);
    if (pipeSocket) {
      intentionalWinPipeCloses.add(pipeSocket);
      pipeSocket.end();
      winPipes.delete(pipeKey);
      winPipeBuffers.delete(pipeKey);
    }
  }
}

/**
 * Create a mux WebSocket server (noServer mode).
 * Returns the WebSocketServer instance for manual upgrade routing.
 */
export function createMuxWebSocket(tmuxPath?: string | null): WebSocketServer | null {
  // On Windows, we use named pipe relay instead of node-pty/tmux.
  // Allow the server to be created without ptySpawn on Windows.
  if (!ptySpawn && !isWindows()) {
    console.warn("[MuxServer] node-pty not available — mux WebSocket will be disabled");
    return null;
  }

  // On Windows, terminal I/O goes through named pipe relay — no TerminalManager needed.
  const terminalManager =
    ptySpawn && !isWindows() ? new TerminalManager(tmuxPath ?? undefined) : null;

  const nextPort = process.env.PORT || "3000";
  const broadcaster = new SessionBroadcaster(nextPort);
  const notificationBroadcaster = new NotificationBroadcaster();

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, request) => {
    console.log("[MuxServer] New mux connection");

    const connectedAt = Date.now();
    // Best-effort remote addr — proxy headers if present, else socket peer.
    const xff = request?.headers["x-forwarded-for"];
    const xffStr = Array.isArray(xff) ? xff[0] : xff;
    const remoteAddr =
      (typeof xffStr === "string" ? xffStr.split(",")[0]?.trim() : undefined) ??
      request?.socket?.remoteAddress ??
      undefined;

    recordActivityEvent({
      source: "ui",
      kind: "ui.terminal_connected",
      level: "info",
      summary: "mux WebSocket connection opened",
      data: { remoteAddr },
    });

    const subscriptions = new Map<string, () => void>();
    // Windows: named pipe sockets keyed by session ID
    const winPipes = new Map<string, ReturnType<typeof netConnect>>();
    // Windows: framing buffers keyed by session ID
    const winPipeBuffers = new Map<string, Buffer>();
    let sessionUnsubscribe: (() => void) | null = null;
    let notificationUnsubscribe: (() => void) | null = null;
    let missedPongs = 0;
    let heartbeatLostEmitted = false;
    const MAX_MISSED_PONGS = 3;

    // Heartbeat: send native WebSocket ping every 15s.
    // Browsers automatically respond to native pings with pong frames —
    // no application-level code is needed on the client side.
    const heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        // Send the ping first so it counts as a sent-but-unanswered probe
        ws.ping();
        missedPongs += 1;
        if (missedPongs >= MAX_MISSED_PONGS) {
          console.log("[MuxServer] Too many missed pongs, terminating connection");
          if (!heartbeatLostEmitted) {
            heartbeatLostEmitted = true;
            recordActivityEvent({
              source: "ui",
              kind: "ui.terminal_heartbeat_lost",
              level: "warn",
              summary: `mux WebSocket heartbeat lost (${missedPongs} missed pongs)`,
              data: {
                missedPongs,
                maxMissedPongs: MAX_MISSED_PONGS,
                connectionAgeMs: Date.now() - connectedAt,
                remoteAddr,
                subscriberCount: subscriptions.size,
              },
            });
          }
          ws.terminate();
        }
      }
    }, 15_000);

    // Native pong resets the missed counter
    ws.on("pong", () => {
      missedPongs = 0;
    });

    /**
     * Handle incoming messages
     */
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString("utf8")) as ClientMessage;

        if (msg.ch === "system") {
          if (msg.type === "ping") {
            const pong: ServerMessage = { ch: "system", type: "pong" };
            ws.send(JSON.stringify(pong));
          }
        } else if (msg.ch === "terminal") {
          const { id, type } = msg;
          const projectId = "projectId" in msg ? msg.projectId : undefined;
          const subscriptionKey = projectId ? `${projectId}:${id}` : id;

          try {
            if (type === "open") {
              if (isWindows()) {
                handleWindowsPipeMessage(
                  msg as {
                    id: string;
                    type: string;
                    projectId?: string;
                    data?: string;
                    cols?: number;
                    rows?: number;
                  },
                  ws,
                  winPipes,
                  winPipeBuffers,
                  { connect: netConnect, resolvePipePath },
                );
              } else {
                // --- Unix: tmux path with project scoping ---
                if (!terminalManager) throw new Error("Terminal manager not available");
                terminalManager.open(id, projectId, "tmuxName" in msg ? msg.tmuxName : undefined);

                // Send opened confirmation (idempotent — safe to send on re-open)
                const openedMsg: ServerMessage = {
                  ch: "terminal",
                  id,
                  type: "opened",
                  ...(projectId && { projectId }),
                };
                ws.send(JSON.stringify(openedMsg));

                // Subscribe and send history buffer only for new subscribers.
                // Skipping the buffer on re-open prevents duplicate output when
                // MuxProvider re-sends open for all terminals on reconnect.
                if (!subscriptions.has(subscriptionKey)) {
                  // Send buffered history to catch up the new subscriber
                  const buffer = terminalManager.getBuffer(id, projectId);
                  if (buffer) {
                    const bufferMsg: ServerMessage = {
                      ch: "terminal",
                      id,
                      type: "data",
                      data: buffer,
                      ...(projectId && { projectId }),
                    };
                    ws.send(JSON.stringify(bufferMsg));
                  }
                  const unsub = terminalManager.subscribe(
                    id,
                    projectId,
                    (data) => {
                      const dataMsg: ServerMessage = {
                        ch: "terminal",
                        id,
                        type: "data",
                        data,
                        ...(projectId && { projectId }),
                      };
                      if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(dataMsg));
                      }
                    },
                    (exitCode) => {
                      const exitedMsg: ServerMessage = {
                        ch: "terminal",
                        id,
                        type: "exited",
                        code: exitCode,
                        ...(projectId && { projectId }),
                      };
                      if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(exitedMsg));
                      }
                    },
                  );
                  subscriptions.set(subscriptionKey, unsub);
                }
              }
            } else if (type === "data" && "data" in msg) {
              if (isWindows()) {
                handleWindowsPipeMessage(
                  msg as { id: string; type: string; projectId?: string; data: string },
                  ws,
                  winPipes,
                  winPipeBuffers,
                  { connect: netConnect, resolvePipePath },
                );
              } else {
                terminalManager?.write(id, msg.data, projectId);
              }
            } else if (type === "resize" && "cols" in msg && "rows" in msg) {
              if (isWindows()) {
                handleWindowsPipeMessage(
                  msg as {
                    id: string;
                    type: string;
                    projectId?: string;
                    cols: number;
                    rows: number;
                  },
                  ws,
                  winPipes,
                  winPipeBuffers,
                  { connect: netConnect, resolvePipePath },
                );
              } else {
                terminalManager?.resize(id, msg.cols, msg.rows, projectId);
              }
            } else if (type === "close") {
              if (isWindows()) {
                handleWindowsPipeMessage(
                  msg as {
                    id: string;
                    type: string;
                    projectId?: string;
                    data?: string;
                    cols?: number;
                    rows?: number;
                  },
                  ws,
                  winPipes,
                  winPipeBuffers,
                  { connect: netConnect, resolvePipePath },
                );
              } else {
                // Unsubscribe this client only — TerminalManager is shared across
                // all mux connections so we must not kill the PTY here.
                const unsub = subscriptions.get(subscriptionKey);
                if (unsub) {
                  unsub();
                  subscriptions.delete(subscriptionKey);
                }
              }
            }
          } catch (err) {
            if (ws.readyState === WebSocket.OPEN) {
              const errorMsg: ServerMessage = {
                ch: "terminal",
                id,
                type: "error",
                message: err instanceof Error ? err.message : String(err),
                ...(projectId && { projectId }),
              };
              ws.send(JSON.stringify(errorMsg));
            }
          }
        } else if (msg.ch === "subscribe") {
          if (msg.topics.includes("sessions") && !sessionUnsubscribe) {
            sessionUnsubscribe = broadcaster.subscribe(
              (sessions) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                if (ws.bufferedAmount > WS_BUFFER_HIGH_WATERMARK) {
                  console.warn("[MuxServer] Skipping session snapshot — socket backpressured");
                  return;
                }
                const snapMsg: ServerMessage = { ch: "sessions", type: "snapshot", sessions };
                ws.send(JSON.stringify(snapMsg));
              },
              (error) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                const errMsg: ServerMessage = { ch: "sessions", type: "error", error };
                ws.send(JSON.stringify(errMsg));
              },
            );
          }
          if (msg.topics.includes("notifications") && !notificationUnsubscribe) {
            notificationUnsubscribe = notificationBroadcaster.subscribe(
              (notifications, type, limit) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                if (ws.bufferedAmount > WS_BUFFER_HIGH_WATERMARK) {
                  console.warn("[MuxServer] Skipping notification update — socket backpressured");
                  return;
                }
                const msg: ServerMessage = {
                  ch: "notifications",
                  type,
                  notifications,
                  limit,
                };
                ws.send(JSON.stringify(msg));
              },
              (error) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                const errMsg: ServerMessage = { ch: "notifications", type: "error", error };
                ws.send(JSON.stringify(errMsg));
              },
            );
          }
        }
      } catch (err) {
        console.error("[MuxServer] Failed to parse message:", err);
        recordActivityEvent({
          source: "ui",
          kind: "ui.terminal_protocol_error",
          level: "warn",
          summary: "invalid mux client message — parse failed",
          data: {
            errorMessage: err instanceof Error ? err.message : String(err),
            remoteAddr,
            subscriberCount: subscriptions.size,
          },
        });
        const errorMsg: ServerMessage = {
          ch: "system",
          type: "error",
          message: "Invalid message format",
        };
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(errorMsg));
        }
      }
    });

    /**
     * Handle connection close
     */
    ws.on("close", (code, reason) => {
      console.log("[MuxServer] Mux connection closed");
      recordActivityEvent({
        source: "ui",
        kind: "ui.terminal_disconnected",
        level: "info",
        summary: "mux WebSocket connection closed",
        data: {
          code,
          reason: reason?.toString("utf8") || undefined,
          connectionAgeMs: Date.now() - connectedAt,
          subscriberCount: subscriptions.size,
          heartbeatLost: heartbeatLostEmitted,
          remoteAddr,
        },
      });
      clearInterval(heartbeatInterval);
      sessionUnsubscribe?.();
      sessionUnsubscribe = null;
      notificationUnsubscribe?.();
      notificationUnsubscribe = null;
      for (const unsub of subscriptions.values()) {
        unsub();
      }
      subscriptions.clear();
      // Windows: close all open pipe sockets
      for (const pipeSocket of winPipes.values()) {
        pipeSocket.destroy();
      }
      winPipes.clear();
      winPipeBuffers.clear();
    });

    // In the ws library, "error" is always followed by "close", so the close
    // handler below handles all cleanup.  Log the error here and nothing more.
    ws.on("error", (err) => {
      console.error("[MuxServer] WebSocket error:", err.message);
    });
  });

  console.log("[MuxServer] Mux WebSocket server created (noServer mode)");
  return wss;
}
