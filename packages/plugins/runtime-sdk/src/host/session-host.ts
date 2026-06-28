/**
 * host/session-host.ts — the transport-agnostic session CORE.
 *
 * `SessionHost` owns the streaming `query()` session, normalizes every SDK
 * message, buffers + persists them, fans them out to live subscribers
 * (snapshot -> live), and runs the canUseTool approval seam. It knows NOTHING
 * about sockets or the SDK wiring — it emits normalized events through `persist`
 * and to registered subscribers, so it is unit-tested without sockets or a real
 * `query()`. The socket/process wiring lives in host/socket-server.ts and the
 * provider drivers in providers/*.
 */

import {
  type SDKMessage,
  type SDKUserMessage,
  type PermissionMode,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { SCHEMA_VERSION, type EventBody, type NormalizedEvent } from "../event-schema.js";
import { translateSdkMessage } from "../sdk-translator.js";
import { encodeLine } from "../protocol.js";

/** A live subscriber: a function that writes one already-encoded NDJSON line. */
export type Send = (line: string) => void;

/**
 * #1 bounded subscribe (opt-in). A subscriber MAY ask for only a tail of history
 * instead of the full buffer, to avoid the RAM/CPU spike of replaying thousands of
 * events on attach to a long-lived session. Absent/empty options = the full
 * snapshot (the original, unbounded behavior — an old client that sends no
 * subscribe command gets exactly this).
 */
export interface SubscribeOptions {
  /**
   * Send only the last N events. The tail is TURN-ALIGNED: it is extended back to
   * the first event of the turn containing the Nth-from-end event, so it never
   * begins mid-turn. That lets the subscriber page strictly-older WHOLE turns from
   * the durable log with no split/overlap at the boundary.
   */
  tailEvents?: number;
  /** Send only events whose seq is strictly greater than this. */
  sinceSeq?: number;
}

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

  /**
   * Non-Claude providers can learn their durable provider/thread id without
   * flowing through an Agent-SDK `system/init` message. Adopt it so subsequent
   * events, hello frames, and session.json carry a real resume target.
   */
  adoptSession(sessionId: string, model?: string | null): void {
    this.sdkSessionId = sessionId;
    if (model !== undefined) this.model = model;
    this.writeSessionInfo();
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
   *
   * `hello` and `snapshot-complete` always carry the TRUE head seq (`this.seq-1`)
   * regardless of how much of the snapshot is replayed — they mark the live
   * boundary. With bounded `opts`, only a tail of the buffer is replayed; the
   * subscriber reads the strictly-older remainder from the durable log itself.
   */
  subscribe(send: Send, opts?: SubscribeOptions): () => void {
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
    for (const event of this.snapshotEvents(opts)) send(encodeLine(event));
    send(encodeLine({ type: "snapshot-complete", seq: this.seq > 0 ? this.seq - 1 : -1 }));
    this.subscribers.add(send);
    return () => this.subscribers.delete(send);
  }

  /**
   * The slice of the buffer to replay on subscribe. Default (no/empty opts) = the
   * WHOLE buffer — byte-for-byte the original behavior, so an old client that sends
   * no subscribe command is unaffected. Bounded opts filter by `sinceSeq` then trim
   * to the last `tailEvents`, extended back to a turn boundary (see SubscribeOptions).
   */
  private snapshotEvents(opts?: SubscribeOptions): NormalizedEvent[] {
    if (!opts || (opts.tailEvents == null && opts.sinceSeq == null)) {
      return this.events;
    }
    let evs: NormalizedEvent[] = this.events;
    if (opts.sinceSeq != null) {
      const since = opts.sinceSeq;
      evs = evs.filter((e) => e.seq > since);
    }
    if (opts.tailEvents != null && opts.tailEvents >= 0) {
      if (opts.tailEvents === 0) return []; // explicit "live only"
      if (evs.length > opts.tailEvents) {
        let start = evs.length - opts.tailEvents;
        // Turn-align: walk back over the partial first turn so the tail begins at a
        // turn boundary. Turns are contiguous in the buffer (a turn's events are
        // emitted in sequence), so this includes the whole head turn.
        const startTurn = evs[start].turn;
        while (start > 0 && evs[start - 1].turn === startTurn) start--;
        evs = evs.slice(start);
      }
    }
    return evs;
  }

  // --- input / turns ----------------------------------------------------

  /**
   * Push a user turn into the streaming input. Returns the seq of the emitted user
   * echo on success, or `null` if the host has ended and cannot accept the turn —
   * the caller turns that into the send ACK's `ok` (see #2).
   */
  submitTurn(text: string): number | null {
    if (this.ended) return null;
    this.submittedTurns += 1;
    // Emit the user turn so events.ndjson is a complete transcript (and live
    // subscribers can render it without an optimistic echo). The echo is stamped
    // with the just-submitted turn (its own number), independent of which turn's
    // response is currently streaming.
    const echo = this.emit({ type: "user", subtype: "input", text }, this.submittedTurns);
    this.input.push(text);
    return echo.seq;
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

  /**
   * Answer a pending permission request (delivered over the socket). Returns `true`
   * if a matching pending request was found and resolved, `false` if there was no
   * such request (already resolved / timed out / unknown id) — the caller turns that
   * into the permission ACK's `ok`, so the UI can tell a delivered answer from one
   * that landed too late (see #2).
   */
  resolvePermission(requestId: string, behavior: "allow" | "deny", message?: string): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    pending(
      behavior === "allow"
        ? { behavior: "allow", updatedInput: {} }
        : { behavior: "deny", message: message ?? "denied" },
    );
    return true;
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
