// Terminal Attachment (see CONTEXT.md): the live binding between a terminal
// pane and a PTY over the mux. The hook owns the whole attachment lifecycle —
// open ordering, auto-reattach with backoff, error surfacing, and exit
// handling — so the pane component only renders.
//
// The PTY is either an agent session's pane (the default) or a standalone
// shell terminal the user opened by hand (options.shellTerminalHandleId). The
// mux draws no distinction between them, so only the handle's source and the
// session-specific side effects branch below.
//
// Status rule: the frontend never writes a session's display status. On mux
// `exited`/`error` it invalidates the workspaces query and lets the daemon's
// derived status flow back (docs/architecture.md).

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { getApiBaseUrl } from "../lib/api-client";
import { captureRendererEvent } from "../lib/telemetry";
import { createTerminalMux, muxUrlFromApiBase, type TerminalMux } from "../lib/terminal-mux";
import { sessionIsActive, type WorkspaceSession } from "../types/workspace";
import { workspaceQueryKey } from "./useWorkspaceQuery";

/**
 * The slice of xterm's Terminal the attachment needs. Structural, so tests can
 * drive the hook with a tiny fake instead of a real xterm + DOM.
 */
export type TerminalUserInputSource = "keyboard" | "paste" | "composition" | "shortcut" | "wheel";

export type AttachableTerminal = {
	cols: number;
	rows: number;
	/**
	 * `done` fires once this exact chunk has been parsed into the buffer (xterm's
	 * own write callback). The attachment uses it to reveal the pane at the
	 * replay's final scroll position instead of guessing with a timer.
	 */
	write: (data: Uint8Array, done?: () => void) => void;
	writeln: (line: string) => void;
	/**
	 * Erase screen + scrollback and home the cursor, preserving terminal modes.
	 * Never a full reset (RIS): that would drop zellij's mouse-tracking mode
	 * for the gap until the fresh attach's handshake re-asserts it — a window
	 * with wheel scroll dead (see XtermTerminal's CLEAR_SEQUENCE).
	 */
	clear: () => void;
	onUserInput: (listener: (data: string, source: TerminalUserInputSource) => void) => { dispose: () => void };
	onResize: (listener: (size: { cols: number; rows: number }) => void) => { dispose: () => void };
};

export type TerminalSessionState =
	| "idle" // nothing attached (no session, or detached)
	| "connecting" // first attach in flight
	| "attached" // server acked the open
	| "reattaching" // socket dropped; waiting on backoff or daemon readiness
	| "exited" // PTY process ended; terminal kept for scrollback
	| "error"; // server reported a pane error; no automatic retry

export type UseTerminalSessionOptions = {
	/** Gates auto-reattach: when false, a dropped socket waits instead of retrying. */
	daemonReady: boolean;
	/** Test seam: build the mux client. Defaults to a fresh socket against the current API base. */
	createMux?: () => TerminalMux;
	/**
	 * Observe decoded pane output (post-write). Callers use it to scan the stream
	 * for signals like printed URLs; it must be cheap and side-effect-light since
	 * it runs on every output chunk. Omit to skip decoding entirely.
	 */
	onOutput?: (text: string) => void;
	/**
	 * Attach to a standalone shell terminal (POST /api/v1/shell-terminals)
	 * instead of a session's pane. When set it wins over `session`, which
	 * callers pass as undefined for shell panes.
	 *
	 * The mux needs no distinction between the two: it treats the id it is
	 * given as an opaque runtime handle either way. Everything downstream of
	 * `handle` in this hook is therefore shared verbatim; only the handle's
	 * source and the session-specific side effects differ.
	 */
	shellTerminalHandleId?: string;
};

const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8_000;
const OPEN_TIMEOUT_MS = 3_000;
// Trailing debounce on grid changes: a pane drag emits a burst of intermediate
// sizes; the attached program should get one SIGWINCH when the drag settles,
// not dozens (yyork's terminal-panel does the same at its socket layer).
const RESIZE_DEBOUNCE_MS = 100;
// One follow-up frame with the same grid after each settled resize. xterm only
// fires onResize on actual grid changes and the kernel only raises SIGWINCH on
// actual size changes, so a resize update the zellij client loses (raced
// mid-attach, coalesced during a drag) would otherwise desync the session's
// layout from the pane until the NEXT real change — the terminal keeps
// painting at the old size. The backend answers every resize frame with an
// explicit SIGWINCH (pty_unix.go), so this re-assert makes the client re-read
// and re-report its grid; when everything is already in sync it's a no-op.
const RESIZE_REASSERT_MS = 250;
// Initial-replay gate. On attach the runtime replays the pane's state, and the
// daemon pumps it in 32KB reads (attachment.go copyOut) — so the renderer gets
// N WebSocket frames, N `write()` calls, and N separate event-loop turns. xterm
// parses each write atomically but the browser paints BETWEEN turns, so every
// frame boundary is a painted, further-scrolled state: the terminal visibly
// walks from mid-session down to the tail. Measured on a 1000-line replay: 25
// frames at 16ms spacing paint 25 distinct scroll positions; the same bytes as
// ONE write paint exactly 1, for ~2ms of parse.
//
// So the replay burst is buffered and written once, with the pane covered until
// that write is parsed. QUIET_MS is the no-data gap that ends the burst; CAP_MS
// bounds the cover if the replay never goes quiet. Hitting the cap still writes
// what has arrived as a single chunk, so the worst case degrades to one jump
// rather than back to the walk.
const REPLAY_QUIET_MS = 60;
const REPLAY_CAP_MS = 750;
// Byte ceiling on the buffered burst. Attaching to a pane that is actively
// streaming (an agent mid-run) means every frame restarts the quiet window, so
// the time bounds alone would hold the entire burst and then land it as one
// enormous parse — a main-thread freeze, which is a worse artifact than the
// scroll this gate exists to remove. At the measured ~44KB/ms parse rate 1MB is
// ~23ms, under two frames. Real replays are far below this; only a pathological
// stream trips it, and tripping it just ends the gate early.
const REPLAY_MAX_BYTES = 1024 * 1024;
// Cover-only grace on the first replay byte. A pane that has produced NOTHING
// has no walk to hide, so holding the cover to the cap just shows a blank
// overlay — and past the pane's label delay (REPLAY_COVER_LABEL_MS in
// TerminalPane.tsx) a "Loading latest output…" label with nothing to load.
// Uncovering on this timer keeps that window short.
//
// It lifts the cover WITHOUT ending the gate: flushing here instead would clear
// `replayBuffering`, and a replay that then arrives late would go to xterm frame
// by frame — the exact walk this gate removes, with no cover left over it. So
// the burst stays coalesced either way and a late one lands as a single paint.
// Longer than the quiet window on purpose: `opened` fires from setPTY before
// copyOut, so the first byte is imminent but not instant, and a value near
// QUIET_MS would uncover panes that were about to draw.
const REPLAY_FIRST_BYTE_MS = 250;

function defaultCreateMux(): TerminalMux {
	// Resolved per connect, not per hook: a daemon restart can change the port.
	return createTerminalMux(muxUrlFromApiBase(getApiBaseUrl()));
}

export function useTerminalSession(session: WorkspaceSession | undefined, options: UseTerminalSessionOptions) {
	const queryClient = useQueryClient();
	const [state, setState] = useState<TerminalSessionState>("idle");
	const [error, setError] = useState<string | undefined>(undefined);
	// False only while the initial replay is being buffered — the pane keeps a
	// cover over xterm until the burst has been written and parsed.
	const [replaySettled, setReplaySettled] = useState(true);

	const sessionRef = useRef(session);
	sessionRef.current = session;
	const previousSessionActiveRef = useRef(session ? sessionIsActive(session) : false);
	const previousActivityStateRef = useRef(session?.activity?.state);
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const stateRef = useRef<TerminalSessionState>(state);
	const connectRef = useRef<() => void>(() => undefined);

	const runtime = useRef({
		terminal: null as AttachableTerminal | null,
		mux: null as TerminalMux | null,
		handle: null as string | null,
		disposers: [] as Array<() => void>,
		retryTimer: null as ReturnType<typeof setTimeout> | null,
		openTimer: null as ReturnType<typeof setTimeout> | null,
		resizeTimer: null as ReturnType<typeof setTimeout> | null,
		// Separate from resizeTimer so a deferred re-assert can coexist with a new
		// debounce without either clobbering the other (see scheduleReassert).
		reassertTimer: null as ReturnType<typeof setTimeout> | null,
		attempts: 0,
		firstAttach: true,
		generation: 0,
		inputReady: false,
		detached: true,
		// Initial-replay gate, reset per connect (see REPLAY_QUIET_MS).
		replayBuffering: false,
		replayChunks: [] as Uint8Array[],
		replayBytes: 0,
		replayQuietTimer: null as ReturnType<typeof setTimeout> | null,
		replayCapTimer: null as ReturnType<typeof setTimeout> | null,
		// Uncovers a pane that never produced a first byte; see
		// REPLAY_FIRST_BYTE_MS. Does not end the gate, so it is not a flush timer.
		replayFirstByteTimer: null as ReturnType<typeof setTimeout> | null,
		// A resize re-assert held back until the replay flushes; see the resize
		// handler for why it cannot fire during the burst.
		replayPendingReassert: null as (() => void) | null,
		// The current attachment's flush, published so teardown can land buffered
		// bytes instead of discarding them (the closure lives inside connect).
		flushReplay: null as (() => void) | null,
	});

	const transition = useCallback((next: TerminalSessionState) => {
		stateRef.current = next;
		setState(next);
	}, []);

	const invalidateWorkspaces = useCallback(() => {
		// A standalone shell has no session row behind it, so its exit carries no
		// news for the session board. Refetching every workspace on `exit` would
		// be pure churn — the shell terminal list owns that pane's fate instead.
		if (optionsRef.current.shellTerminalHandleId) return;
		void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
	}, [queryClient]);

	const clearReplayTimers = useCallback(() => {
		const r = runtime.current;
		if (r.replayQuietTimer) {
			clearTimeout(r.replayQuietTimer);
			r.replayQuietTimer = null;
		}
		if (r.replayCapTimer) {
			clearTimeout(r.replayCapTimer);
			r.replayCapTimer = null;
		}
		if (r.replayFirstByteTimer) {
			clearTimeout(r.replayFirstByteTimer);
			r.replayFirstByteTimer = null;
		}
	}, []);

	const teardownMux = useCallback(() => {
		const r = runtime.current;
		// Land anything still buffered before the attachment goes away. Dropping
		// it would lose output that had already arrived — invisible on screen
		// (the next attach clears and replays), but the onOutput watcher would
		// never see it, so a URL printed in that window would never badge the
		// Browser tab. No-ops when the gate is closed or already superseded.
		r.flushReplay?.();
		r.flushReplay = null;
		clearReplayTimers();
		r.replayBuffering = false;
		r.replayChunks = [];
		r.replayBytes = 0;
		r.replayPendingReassert = null;
		// Nothing is buffering any more, so nothing should stay covered. connect()
		// re-arms the gate immediately after calling this, in the same tick, so
		// the reveal here never flashes. Without it, a teardown that does not
		// reconnect (open timeout while the daemon is down) strands the pane
		// behind the cover — the cap no longer covers that case now it is armed
		// from `opened` rather than from connect().
		setReplaySettled(true);
		if (r.retryTimer) {
			clearTimeout(r.retryTimer);
			r.retryTimer = null;
		}
		if (r.openTimer) {
			clearTimeout(r.openTimer);
			r.openTimer = null;
		}
		if (r.resizeTimer) {
			clearTimeout(r.resizeTimer);
			r.resizeTimer = null;
		}
		if (r.reassertTimer) {
			clearTimeout(r.reassertTimer);
			r.reassertTimer = null;
		}
		r.inputReady = false;
		if (r.mux && r.handle) {
			r.mux.close(r.handle);
		}
		r.disposers.forEach((dispose) => dispose());
		r.disposers = [];
		r.mux?.dispose();
		r.mux = null;
	}, [clearReplayTimers]);

	const isCurrentAttachment = useCallback((generation: number, handle: string, mux: TerminalMux) => {
		const r = runtime.current;
		return !r.detached && r.generation === generation && r.handle === handle && r.mux === mux;
	}, []);

	const clearOpenTimer = useCallback((generation: number) => {
		const r = runtime.current;
		if (r.generation !== generation || !r.openTimer) return;
		clearTimeout(r.openTimer);
		r.openTimer = null;
	}, []);

	const scheduleReattach = useCallback(() => {
		const r = runtime.current;
		if (r.detached || !r.terminal || !r.handle) {
			return;
		}
		// A socket dropping after the PTY ended (or errored) changes nothing.
		if (stateRef.current === "exited" || stateRef.current === "error") {
			return;
		}
		transition("reattaching");
		// Not ready → no timer; the daemonReady effect reconnects when it flips.
		if (!optionsRef.current.daemonReady) {
			return;
		}
		if (r.retryTimer) {
			return;
		}
		const delay = Math.min(RETRY_BASE_MS * 2 ** r.attempts, RETRY_MAX_MS);
		r.attempts += 1;
		r.retryTimer = setTimeout(() => {
			r.retryTimer = null;
			connectRef.current();
		}, delay);
	}, [transition]);

	const connect = useCallback(() => {
		const r = runtime.current;
		const { terminal, handle } = r;
		if (!terminal || !handle || r.detached) {
			return;
		}
		// Flush the outgoing attachment BEFORE bumping the generation: past that
		// point its own guard rejects the flush and its buffered bytes are lost.
		r.flushReplay?.();
		const generation = r.generation + 1;
		r.generation = generation;
		r.inputReady = false;
		teardownMux();

		const mux = (optionsRef.current.createMux ?? defaultCreateMux)();
		r.mux = mux;

		// Streaming decoder so a multi-byte sequence split across chunks decodes
		// correctly for onOutput. Only built when a caller is listening.
		const outputDecoder = optionsRef.current.onOutput ? new TextDecoder() : null;

		const emitOutput = (bytes: Uint8Array) => {
			if (outputDecoder) optionsRef.current.onOutput?.(outputDecoder.decode(bytes, { stream: true }));
		};

		// End the initial-replay burst: concatenate everything buffered so far
		// into one write so xterm parses it in a single pass (no intermediate
		// paints), and uncover the pane once that write is parsed.
		//
		// Safe to call from anywhere — a second call is a no-op, and a call from
		// a superseded attachment is dropped.
		const flushReplay = () => {
			if (!r.replayBuffering) return;
			if (!isCurrentAttachment(generation, handle, mux)) return;
			r.replayBuffering = false;
			clearReplayTimers();

			const chunks = r.replayChunks;
			r.replayChunks = [];
			r.replayBytes = 0;
			const pendingReassert = r.replayPendingReassert;
			r.replayPendingReassert = null;

			if (chunks.length === 0) {
				// Nothing buffered, so there is nothing to reveal at a settled
				// position — just make sure the cover is off. Reaching here means an
				// exit, error, dead socket or the cap; a pane that is merely slow to
				// draw was already uncovered by REPLAY_FIRST_BYTE_MS without ending
				// the gate.
				setReplaySettled(true);
				pendingReassert?.();
				return;
			}

			let total = 0;
			for (const chunk of chunks) total += chunk.length;
			const replay = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				replay.set(chunk, offset);
				offset += chunk.length;
			}
			// Observers (the URL watcher) must still see the replay text, and see
			// it once, in order — decode the joined buffer, not the pieces.
			emitOutput(replay);
			terminal.write(replay, () => {
				if (!isCurrentAttachment(generation, handle, mux)) return;
				setReplaySettled(true);
			});
			pendingReassert?.();
		};
		r.flushReplay = flushReplay;

		r.disposers.push(
			mux.onData(handle, (bytes) => {
				if (!isCurrentAttachment(generation, handle, mux)) return;
				if (r.replayBuffering) {
					r.replayChunks.push(bytes);
					r.replayBytes += bytes.length;
					// A stream that never idles would restart the quiet window forever
					// and grow the buffer without bound; flush on size instead.
					if (r.replayBytes >= REPLAY_MAX_BYTES) {
						flushReplay();
						return;
					}
					// Each frame restarts the quiet window: the burst is over only
					// once the stream actually goes idle.
					if (r.replayQuietTimer) clearTimeout(r.replayQuietTimer);
					r.replayQuietTimer = setTimeout(flushReplay, REPLAY_QUIET_MS);
					return;
				}
				terminal.write(bytes);
				emitOutput(bytes);
			}),
			mux.onOpened(handle, () => {
				if (!isCurrentAttachment(generation, handle, mux)) return;
				clearOpenTimer(generation);
				r.inputReady = true;
				r.attempts = 0;
				setError(undefined);
				transition("attached");
				// Bound the gate from here: the daemon fires onOpen from setPTY and
				// starts copyOut immediately after, so the replay is imminent and
				// the cap now measures the burst rather than the connect handshake.
				if (r.replayBuffering && !r.replayCapTimer) {
					r.replayCapTimer = setTimeout(flushReplay, REPLAY_CAP_MS);
				}
				// Same anchor, different job: uncover a pane that turns out to have
				// nothing to replay (see REPLAY_FIRST_BYTE_MS). Deliberately not a
				// flush — the gate stays armed so a late burst is still coalesced.
				if (r.replayBuffering && !r.replayFirstByteTimer) {
					r.replayFirstByteTimer = setTimeout(() => {
						r.replayFirstByteTimer = null;
						if (!isCurrentAttachment(generation, handle, mux)) return;
						// Bytes arrived, or the burst already flushed: the flush owns
						// the reveal in both cases, at the settled scroll position.
						if (!r.replayBuffering || r.replayChunks.length > 0) return;
						setReplaySettled(true);
					}, REPLAY_FIRST_BYTE_MS);
				}
			}),
			mux.onExit(handle, () => {
				if (!isCurrentAttachment(generation, handle, mux)) return;
				clearOpenTimer(generation);
				r.inputReady = false;
				// Land whatever was buffered before the notice, and lift the cover:
				// a pane that exits mid-replay must never be left behind it.
				flushReplay();
				terminal.writeln("\r\n\x1b[2m[process exited]\x1b[0m");
				transition("exited");
				invalidateWorkspaces();
			}),
			mux.onError(handle, (message) => {
				if (!isCurrentAttachment(generation, handle, mux)) return;
				clearOpenTimer(generation);
				r.inputReady = false;
				flushReplay();
				terminal.writeln(`\r\n\x1b[2m[terminal error] ${message}\x1b[0m`);
				setError(message);
				transition("error");
				void captureRendererEvent("ao.renderer.terminal_attach_failed", { reason: "pane_error" });
				invalidateWorkspaces();
			}),
			mux.onConnectionChange((connectionState) => {
				if (!isCurrentAttachment(generation, handle, mux)) return;
				if (connectionState === "closed") {
					// End the gate: no replay is coming over a dead socket. This is
					// the ONLY settle path when the socket dies before `opened` —
					// clearOpenTimer below drops the open timeout, and
					// scheduleReattach schedules nothing while the daemon is down,
					// so without this the pane is stranded behind the cover with no
					// timer left to lift it (and stays there for a whole reconnect
					// storm). The cap cannot cover this: it is armed from `opened`.
					flushReplay();
					clearOpenTimer(generation);
					r.inputReady = false;
					scheduleReattach();
				}
			}),
		);
		const input = terminal.onUserInput((data) => {
			if (!isCurrentAttachment(generation, handle, mux) || !r.inputReady) {
				return;
			}
			// Input is accepted from `opened`, which lands before the replay — so a
			// user can type while the gate still holds the burst, and their echo
			// would sit in the buffer behind an opaque cover. Someone typing has
			// stopped caring about a tidy reveal and needs to see the pane now:
			// end the gate immediately.
			flushReplay();
			mux.sendInput(handle, data);
		});
		// xterm only fires onResize when the grid actually changed; the debounce
		// additionally collapses a drag's burst of changes into one PTY resize.
		// Each settled resize is re-asserted once (see RESIZE_REASSERT_MS).
		//
		// The re-assert owns a SEPARATE timer slot from the debounce. It used to
		// share resizeTimer, which was safe only while the two stages were strictly
		// sequential. Deferring the re-assert past a replay flush breaks that: a new
		// drag can install a debounce into the shared slot while a deferred
		// re-assert is still pending, and firing the re-assert then overwrites the
		// slot without cancelling the debounce — both run, and the PTY gets the
		// STALE grid after the newer one, costing a SIGWINCH repaint at the wrong
		// size right as the cover lifts.
		const scheduleReassert = (cols: number, rows: number) => {
			if (r.reassertTimer) clearTimeout(r.reassertTimer);
			r.reassertTimer = setTimeout(() => {
				r.reassertTimer = null;
				if (!isCurrentAttachment(generation, handle, mux)) return;
				mux.resize(handle, cols, rows);
			}, RESIZE_REASSERT_MS);
		};
		const resize = terminal.onResize(({ cols, rows }) => {
			if (!isCurrentAttachment(generation, handle, mux)) return;
			if (r.resizeTimer) clearTimeout(r.resizeTimer);
			// A newer grid supersedes any pending re-assert of the old one.
			if (r.reassertTimer) {
				clearTimeout(r.reassertTimer);
				r.reassertTimer = null;
			}
			r.replayPendingReassert = null;
			r.resizeTimer = setTimeout(() => {
				r.resizeTimer = null;
				if (!isCurrentAttachment(generation, handle, mux)) return;
				mux.resize(handle, cols, rows);
				// The backend answers every resize frame with an explicit SIGWINCH,
				// so the re-assert costs a full application repaint ~250ms later.
				// Firing it mid-burst would push those repaint bytes into the
				// buffer, and every added frame restarts the quiet window — so the
				// cover stays down longer for output the user cannot see yet. Hold
				// it until the flush so the burst can go quiet on its own.
				//
				// Note this does NOT hide the repaint: deferring lands it ~250ms
				// after the reveal, whereas firing mid-burst would have folded it
				// into the single write. The trade is a shorter cover for one
				// post-reveal repaint at the correct size.
				//
				// Never dropped — losing the re-assert leaves the pane laid out for
				// the old grid until the next real change. Only deferred once a
				// burst is actually in flight; a pane replaying nothing keeps the
				// plain timing.
				if (r.replayBuffering && r.replayChunks.length > 0) {
					r.replayPendingReassert = () => scheduleReassert(cols, rows);
					return;
				}
				scheduleReassert(cols, rows);
			}, RESIZE_DEBOUNCE_MS);
		});
		r.disposers.push(
			() => input.dispose(),
			() => resize.dispose(),
		);

		// Connection status is chrome (the pane's banner), never buffer content —
		// the PTY owns the buffer. Each open spawns a fresh server-side `zellij
		// attach` (backend internal/terminal/attachment.go) that answers with its
		// init handshake + a full repaint; clear the stale screen so the repaint
		// lands on a blank grid. Screen-clear only, never reset(): RIS would drop
		// zellij's mouse-tracking mode until the handshake lands.
		if (!r.firstAttach) {
			terminal.clear();
		}
		r.firstAttach = false;

		// Open the replay gate before the pane can produce any output. It cannot
		// wait for `opened`: the daemon fires onOpen from setPTY and only then
		// starts copyOut (attachment.go), so `attached` arrives before the first
		// replay byte and would uncover a pane that has not drawn yet.
		r.replayBuffering = true;
		r.replayChunks = [];
		r.replayBytes = 0;
		r.replayPendingReassert = null;
		setReplaySettled(false);
		// The cap is armed from `opened`, NOT from here. A slow attach — the
		// daemon runs a liveness probe and spawns the runtime client before the
		// first byte, which is why OPEN_TIMEOUT_MS budgets 3s — would otherwise
		// burn the whole cap on the handshake, flush an empty buffer, and leave
		// `replayBuffering` false for the rest of the attachment. The replay
		// would then land frame-by-frame with the bug fully intact, behind a
		// pointless blank cover. `opened` fires from setPTY immediately before
		// copyOut, so anchoring there means the cap only ever measures the burst.
		// If `opened` never arrives, openTimer tears down and teardownMux lifts
		// the cover.

		mux.open(handle, terminal.cols, terminal.rows);
		mux.resize(handle, terminal.cols, terminal.rows);
		r.openTimer = setTimeout(() => {
			if (!isCurrentAttachment(generation, handle, mux)) return;
			r.openTimer = null;
			// Only the first timeout of a reattach sequence is reported; the
			// backoff loop retrying against a restarting daemon is not news.
			if (r.attempts === 0) {
				void captureRendererEvent("ao.renderer.terminal_attach_failed", { reason: "open_timeout" });
			}
			transition("reattaching");
			teardownMux();
			scheduleReattach();
		}, OPEN_TIMEOUT_MS);
	}, [
		clearOpenTimer,
		clearReplayTimers,
		invalidateWorkspaces,
		isCurrentAttachment,
		scheduleReattach,
		teardownMux,
		transition,
	]);
	connectRef.current = connect;

	/**
	 * Bind a terminal to the current session's PTY. Call once the terminal is
	 * opened (and fitted); returns the detach function for effect cleanup.
	 */
	const attach = useCallback(
		(terminal: AttachableTerminal) => {
			const r = runtime.current;
			const handle = optionsRef.current.shellTerminalHandleId ?? sessionRef.current?.terminalHandleId ?? null;
			r.terminal = terminal;
			r.handle = handle;
			r.detached = false;
			r.attempts = 0;
			r.firstAttach = true;
			setError(undefined);
			if (handle) {
				if (optionsRef.current.daemonReady) {
					transition("connecting");
					connect();
				} else {
					transition("reattaching");
				}
			} else {
				transition("idle");
			}
			return () => {
				// Before the generation bump — past it the flush's own guard rejects
				// it and the buffered bytes (and any URL in them) are lost. This is
				// the session-switch path, so it is the one that matters most.
				r.flushReplay?.();
				r.generation += 1;
				r.detached = true;
				teardownMux();
				r.terminal = null;
				r.handle = null;
				r.inputReady = false;
				setError(undefined);
				// Detaching ends any pending replay: never leave the next mount of
				// this hook believing a burst is still in flight.
				setReplaySettled(true);
				transition("idle");
			};
		},
		[connect, teardownMux, transition],
	);

	// Daemon came back while we were waiting: reconnect immediately, without
	// backoff debt from attempts made against the dead daemon.
	const daemonReady = options.daemonReady;
	useEffect(() => {
		const r = runtime.current;
		if (!daemonReady || r.detached) return;
		if (stateRef.current !== "reattaching" || r.retryTimer) return;
		r.attempts = 0;
		connect();
	}, [daemonReady, connect]);

	useEffect(() => {
		const r = runtime.current;
		const handle = session?.terminalHandleId ?? null;
		const isActive = session ? sessionIsActive(session) : false;
		const wasActive = previousSessionActiveRef.current;
		const previousActivityState = previousActivityStateRef.current;
		previousSessionActiveRef.current = isActive;
		previousActivityStateRef.current = session?.activity?.state;
		const restoredSession = !wasActive && isActive;
		const resumedAgent = previousActivityState === "exited" && session?.activity?.state !== "exited";
		if (!handle || (!restoredSession && !resumedAgent) || r.detached || !r.terminal) {
			return;
		}
		if (r.handle !== handle) return;
		if (stateRef.current !== "exited" && stateRef.current !== "error") return;
		if (optionsRef.current.daemonReady) {
			transition("connecting");
			connect();
		} else {
			transition("reattaching");
		}
	}, [
		connect,
		session?.activity?.state,
		session?.isTerminated,
		session?.status,
		session?.terminalHandleId,
		transition,
	]);

	// Belt-and-braces: never leak a socket past unmount, even if the owner
	// forgot to call detach.
	useEffect(
		() => () => {
			const r = runtime.current;
			// Same ordering rule as the detach path above.
			r.flushReplay?.();
			r.generation += 1;
			r.detached = true;
			r.inputReady = false;
			teardownMux();
		},
		[teardownMux],
	);

	return { attach, state, error, replaySettled };
}
