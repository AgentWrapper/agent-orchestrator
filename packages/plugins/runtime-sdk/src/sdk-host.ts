/**
 * sdk-host.ts — the long-lived runtime-sdk HOST.
 *
 * Dual-purpose, like runtime-process/pty-host.ts:
 *   1. Module — exports `SessionHost`, a transport-agnostic core that owns the
 *      streaming `query()` session, normalizes every SDK message, buffers +
 *      persists them, fans them out to live subscribers (snapshot -> live), and
 *      runs the canUseTool approval seam. Unit-tested without sockets or the SDK.
 *   2. Standalone script — `node sdk-host.js <aoSessionId>` wires `SessionHost`
 *      to a real `net` server (Unix socket / named pipe) and a real `query()`,
 *      then survives parent exit (spawned detached by index.ts).
 *
 * The host owns the session so it survives orchestrator/Maestro restarts; the
 * provider session id is captured from the SDK `init` and persisted so a fresh
 * host can reattach via `options.resume`.
 */

import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import net from "node:net";
import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type PermissionMode,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { SCHEMA_VERSION, type EventBody, type NormalizedEvent } from "./event-schema.js";
import { translateSdkMessage } from "./sdk-translator.js";
import {
  encodeLine,
  LineParser,
  sessionPaths,
  type ClientCommand,
  type SessionInfo,
} from "./protocol.js";

/** A live subscriber: a function that writes one already-encoded NDJSON line. */
type Send = (line: string) => void;

export interface SessionHostOptions {
  aoSessionId: string;
  permissionMode: PermissionMode;
  /** Provider session id to resume; null/undefined for a fresh session. */
  resumeFrom?: string | null;
  model?: string | null;
  /** Sink for durable persistence — one encoded NDJSON line per call. */
  persist: (line: string) => void;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** ms to wait for a human/UI permission answer before defaulting. 0 = wait. */
  permissionTimeoutMs?: number;
  /**
   * Monotonic host-instance id for this AO session, advertised in the `hello`
   * frame so subscribers detect a resurrected host deterministically (instead
   * of heuristically from seq_head). Increments per host process; 0 for the
   * first instance.
   */
  epoch?: number;
}

interface PushableInput extends AsyncIterable<SDKUserMessage> {
  push: (text: string) => void;
  close: () => void;
}

function makePushableInput(): PushableInput {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(text: string) {
      queue.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      });
      if (wake) {
        wake();
        wake = null;
      }
    },
    close() {
      closed = true;
      if (wake) {
        wake();
        wake = null;
      }
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const item = queue.shift();
        if (item !== undefined) {
          yield item;
          continue;
        }
        if (closed) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
}

/**
 * Transport-agnostic session core. Knows nothing about sockets — it emits
 * normalized events through `persist` and to registered subscribers.
 */
export class SessionHost {
  private readonly opts: SessionHostOptions;
  private readonly now: () => Date;
  private seq = 0;
  /** Count of user turns submitted (drives the user/input echo stamp). */
  private submittedTurns = 0;
  /**
   * The user turn whose response is currently streaming. Response events are
   * stamped with THIS, not submittedTurns — otherwise back-to-back submits
   * (turns 1/2/3 pushed before turn 1 finishes) would stamp every response with
   * the latest submitted turn, collapsing distinct answers into one bubble.
   */
  private respondingTurn = 0;
  /** True while inside a turn's response (between its first event and `result`). */
  private turnInProgress = false;
  private sdkSessionId: string | null;
  private model: string | null;
  private ended = false;
  /** Full in-memory event buffer for snapshot-on-connect. */
  private readonly events: NormalizedEvent[] = [];
  private readonly subscribers = new Set<Send>();
  private readonly pendingPermissions = new Map<
    string,
    (result: PermissionResult) => void
  >();
  private permissionCounter = 0;
  private readonly epoch: number;
  private readonly resumedFrom: string | null;
  readonly input: PushableInput = makePushableInput();

  constructor(opts: SessionHostOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
    this.resumedFrom = opts.resumeFrom ?? null;
    this.sdkSessionId = this.resumedFrom;
    this.model = opts.model ?? null;
    this.epoch = opts.epoch ?? 0;
  }

  // --- emission ---------------------------------------------------------

  /** Stamp the envelope, buffer, persist, and broadcast one event body. */
  emit(body: EventBody, turn: number = this.respondingTurn): NormalizedEvent {
    const event = {
      ...body,
      v: SCHEMA_VERSION,
      seq: this.seq++,
      ts: this.now().toISOString(),
      session_id: this.sdkSessionId,
      turn,
    } as NormalizedEvent;
    this.events.push(event);
    const line = encodeLine(event);
    // Every event MUST reach BOTH the durable log AND every live subscriber, and
    // neither sink may abort the other or the turn. A raw throw here propagates
    // into consume()'s `for await` loop, trips its catch→end(), and TERMINATES the
    // whole streaming session — which is exactly how the live broadcast "stops"
    // mid-turn while events.ndjson keeps growing: one subscriber whose socket died
    // between our `destroyed` check and the write (EPIPE / write-after-FIN) throws,
    // killing fan-out to the others AND ending the session. Isolate both sinks.
    try {
      this.opts.persist(line);
    } catch {
      /* a persist hiccup must not kill the turn or the live stream */
    }
    for (const send of this.subscribers) {
      try {
        send(line);
      } catch {
        // Drop the broken subscriber; its own close/error handler unsubscribes too.
        this.subscribers.delete(send);
      }
    }
    return event;
  }

  // --- subscription (snapshot -> live) ----------------------------------

  /**
   * Register a live subscriber. Synchronously pushes the snapshot+live
   * handshake, then keeps the subscriber for live events. Returns an
   * unsubscribe function. No `await` here, so no event can interleave between
   * the snapshot and joining the live set.
   */
  subscribe(send: Send): () => void {
    send(
      encodeLine({
        type: "hello",
        role: "host",
        session_id: this.sdkSessionId,
        seq_head: this.seq > 0 ? this.seq - 1 : -1,
        epoch: this.epoch,
        resumed: this.resumedFrom !== null,
        resumed_from: this.resumedFrom,
      }),
    );
    for (const event of this.events) send(encodeLine(event));
    send(encodeLine({ type: "snapshot-complete", seq: this.seq > 0 ? this.seq - 1 : -1 }));
    this.subscribers.add(send);
    return () => this.subscribers.delete(send);
  }

  // --- input / turns ----------------------------------------------------

  /** Push a user turn into the streaming input. */
  submitTurn(text: string): void {
    if (this.ended) return;
    this.submittedTurns += 1;
    // Emit the user turn so events.ndjson is a complete transcript (and live
    // subscribers can render it without an optimistic echo). The echo is stamped
    // with the just-submitted turn (its own number), independent of which turn's
    // response is currently streaming.
    this.emit({ type: "user", subtype: "input", text }, this.submittedTurns);
    this.input.push(text);
  }

  // --- permission seam --------------------------------------------------

  /** The canUseTool callback to hand to query() (non-bypass modes only). */
  canUseTool = (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    const requestId = `perm-${++this.permissionCounter}`;
    this.emit({
      type: "permission_request",
      request_id: requestId,
      tool_name: toolName,
      input,
    });
    return new Promise<PermissionResult>((resolve) => {
      let settled = false;
      const finish = (result: PermissionResult, behavior: "allow" | "deny", message?: string) => {
        if (settled) return;
        settled = true;
        this.pendingPermissions.delete(requestId);
        this.emit({ type: "permission_resolved", request_id: requestId, behavior, message });
        resolve(result);
      };
      this.pendingPermissions.set(requestId, (result) =>
        finish(result, result.behavior, result.behavior === "deny" ? result.message : undefined),
      );
      const timeout = this.opts.permissionTimeoutMs ?? 0;
      if (timeout > 0) {
        setTimeout(
          () =>
            finish(
              { behavior: "deny", message: "approval timed out" },
              "deny",
              "approval timed out",
            ),
          timeout,
        ).unref();
      }
    });
  };

  /** Answer a pending permission request (delivered over the socket). */
  resolvePermission(requestId: string, behavior: "allow" | "deny", message?: string): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    pending(
      behavior === "allow"
        ? { behavior: "allow", updatedInput: {} }
        : { behavior: "deny", message: message ?? "denied" },
    );
  }

  // --- query consumption ------------------------------------------------

  /** Drive the normalized event stream from the SDK message iterable. */
  async consume(messages: AsyncIterable<SDKMessage>): Promise<void> {
    if (this.opts.resumeFrom) {
      // Pre-turn lifecycle marker — stamp 0; no turn's response is streaming yet.
      this.emit({ type: "session", subtype: "resumed", session_id: this.opts.resumeFrom }, 0);
    }
    try {
      for await (const msg of messages) {
        if (msg.type === "system" && msg.subtype === "init") {
          this.sdkSessionId = msg.session_id;
          this.model = msg.model;
          this.writeSessionInfo();
        }
        const bodies = translateSdkMessage(msg, this.model);
        // Advance the responding turn at each turn boundary: the first message of
        // a new turn (the first overall, and the first after every `result`)
        // belongs to the next submitted user turn. Done per-message, not per-body,
        // so a result message's trailing `usage` body stays on the turn that just
        // ended. Bounded by submittedTurns so a stray event after a turn ends
        // stamps with the last turn instead of over-counting.
        if (bodies.length > 0 && !this.turnInProgress && this.respondingTurn < this.submittedTurns) {
          this.respondingTurn += 1;
          this.turnInProgress = true;
        }
        let endsTurn = false;
        for (const body of bodies) {
          this.emit(body);
          if (body.type === "result") endsTurn = true;
        }
        if (endsTurn) this.turnInProgress = false;
      }
    } catch (err) {
      this.emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        fatal: true,
      });
    } finally {
      this.end();
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.emit({
      type: "session",
      subtype: "end",
      session_id: this.sdkSessionId ?? "",
    });
    this.input.close();
  }

  private writeSessionInfo(): void {
    if (!this.onSessionInfo) return;
    this.onSessionInfo({
      sdkSessionId: this.sdkSessionId,
      model: this.model,
    });
  }

  /** Optional hook the runner sets to persist session.json on init. */
  onSessionInfo?: (partial: { sdkSessionId: string | null; model: string | null }) => void;

  // --- introspection (for status / getOutput) ---------------------------

  status(): { alive: boolean; session_id: string | null; seq: number; turns: number } {
    return {
      alive: !this.ended,
      session_id: this.sdkSessionId,
      seq: this.seq > 0 ? this.seq - 1 : -1,
      turns: this.submittedTurns,
    };
  }

  /** Render the last N events into compact text for ao's getOutput(). */
  renderOutput(lines: number): string {
    const out: string[] = [];
    for (const e of this.events) {
      switch (e.type) {
        case "user":
          out.push(`\n> ${e.text}\n`);
          break;
        case "text-delta":
          out.push(e.text);
          break;
        case "tool_use":
          out.push(`\n[tool: ${e.name}]`);
          break;
        case "tool_result":
          out.push(`\n[tool result${e.is_error ? " error" : ""}]`);
          break;
        case "result":
          out.push(`\n[turn ${e.num_turns} ${e.subtype}]`);
          break;
        case "permission_request":
          out.push(`\n[approval needed: ${e.tool_name}]`);
          break;
        default:
          break;
      }
    }
    const text = out.join("");
    const split = text.split("\n");
    return split.slice(Math.max(0, split.length - lines)).join("\n");
  }
}

// ===========================================================================
// Standalone entry-point
// ===========================================================================

const isMain =
  process.argv[1]?.endsWith("sdk-host.js") || process.argv[1]?.endsWith("sdk-host.ts");

if (isMain) {
  void runStandalone();
}

async function runStandalone(): Promise<void> {
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
  const permissionTimeoutMs = Number(process.env.AO_SDK_PERMISSION_TIMEOUT_MS || "0") || 0;

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
    persist: (line) => appendFileSync(paths.eventLog, line),
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

  const server = net.createServer((sock) => {
    sock.setEncoding("utf-8");
    const unsubscribe = host.subscribe((line) => {
      if (!sock.destroyed) sock.write(line);
    });
    const parser = new LineParser((obj) => handleClientCommand(host, sock, obj));
    sock.on("data", (chunk) => parser.feed(chunk));
    sock.on("close", unsubscribe);
    sock.on("error", unsubscribe);
  });

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

  // --- start the streaming query ---
  const useCanUseTool = permissionMode !== "bypassPermissions";
  const q = query({
    prompt: host.input,
    options: {
      cwd,
      // Pin the filesystem settings sources explicitly. In claude-agent-sdk
      // 0.3.186 the omitted default is ALREADY ["user","project","local"]
      // (runtime constant `Wre`, mirrored by resolveSettings) — so this is a
      // behavior-preserving no-op today. We keep it as a defensive pin: it
      // documents that the spawned session DEPENDS on file settings being
      // loaded, and guards against a future SDK bump flipping the default to
      // isolation mode (`[]`). What we rely on: 'user' → ~/.claude discipline
      // hooks (orchestrator-no-inline-code, pre-spawn-rlm, rtk); 'project'/'local'
      // → ao's per-worktree .claude activity/metadata inject. settingSources
      // governs ONLY settings/hook loading — permission approval still flows
      // through permissionMode/allowDangerouslySkipPermissions below, so
      // bypassPermissions keeps priority and no MCP/permission surprises leak in.
      settingSources: ["user", "project", "local"],
      permissionMode,
      allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
      includePartialMessages: true,
      ...(resumeFrom ? { resume: resumeFrom } : {}),
      ...(model ? { model } : {}),
      ...(useCanUseTool ? { canUseTool: host.canUseTool } : {}),
      stderr: () => {},
    },
  });

  if (initialPrompt) host.submitTurn(initialPrompt);

  await host.consume(q);
  shutdown("session-ended");
}

/** Handle one decoded client command line. */
function handleClientCommand(host: SessionHost, sock: net.Socket, obj: unknown): void {
  if (typeof obj !== "object" || obj === null) return;
  const cmd = obj as ClientCommand;
  switch (cmd.cmd) {
    case "send":
      if (typeof cmd.text === "string") host.submitTurn(cmd.text);
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
        host.resolvePermission(cmd.request_id, cmd.behavior, cmd.message);
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
