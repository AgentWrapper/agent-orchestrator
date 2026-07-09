// Self-contained xterm.js surface, ported from yyork's terminal architecture.
//
// Design rules (the reason this component exists):
//  - The mount effect is dependency-free: the terminal instance is created once
//    per mount and NEVER torn down because a callback identity changed.
//    TerminalPane chooses the mount lifetime; it keys mounts by terminal handle
//    so session switches get a clean surface, while same-handle reconnects reuse
//    the mounted renderer.
//  - Nothing writes into the buffer at mount. Status/empty-state belongs to DOM
//    chrome around the terminal, not inside it. Writing before layout settles
//    is what crashed xterm's Viewport (`dimensions` of a zero-sized renderer).
//  - Fitting runs on several triggers, not one: FitAddon derives the grid from
//    the measured cell box, and if it measures before the monospace font's real
//    metrics (and the post-open renderer) are resolved it mis-counts cols/rows
//    and the grid clips inside the panel. So: next frame, two settle timeouts,
//    fonts.ready, a ResizeObserver, AND an onRender convergence loop that
//    re-fits until the proposed grid stops changing (the last is the only
//    trigger that recovers a clipped grid without the host box resizing). xterm
//    itself only fires onResize when the grid actually changed, so repeated
//    fits don't spam the PTY.

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import type { AttachableTerminal, TerminalUserInputSource } from "../hooks/useTerminalSession";
import { aoBridge } from "../lib/bridge";
import { buildTerminalThemes } from "../lib/terminal-themes";
import type { Theme } from "../stores/ui-store";

export type XtermTerminalProps = {
	ariaLabel?: string;
	className?: string;
	fontSize?: number;
	theme: Theme;
	/**
	 * The pane app scrolls its transcript by keyboard (PageUp/PageDown) rather
	 * than acting on SGR wheel reports — e.g. opencode, which enables mouse
	 * tracking but never scrolls on wheel reports. Routes the wheel to page keys
	 * on every platform (see the wheel handler), fixing it under a mux too.
	 */
	paneScrollsByKeyboard?: boolean;
	/** Terminal construction failed; the owner decides how to surface it. */
	onError?: (error: unknown) => void;
	/**
	 * The terminal is open in the DOM and ready to be attached to a PTY. The
	 * handle stays valid until unmount; cols/rows are live getters.
	 */
	onReady?: (terminal: AttachableTerminal) => void;
};

// Prefer the WebGL renderer, fall back to 2D canvas. Both rasterize box-drawing
// glyphs themselves onto a fixed cell grid; the DOM renderer does not, so TUI
// borders would drift. Loaded after open().
function loadRenderer(term: Terminal): void {
	try {
		const webgl = new WebglAddon();
		webgl.onContextLoss(() => webgl.dispose());
		term.loadAddon(webgl);
		return;
	} catch {
		// WebGL context unavailable — fall through to the canvas renderer.
	}
	try {
		term.loadAddon(new CanvasAddon());
	} catch (error) {
		console.warn("xterm: WebGL and canvas renderers unavailable; box-drawing may drift", error);
	}
}

// xterm palette tracks the app theme (see lib/terminal-themes.ts + --term-* in
// styles.css). The PTY content is still the agent's own ANSI output.
const terminalThemes = buildTerminalThemes();
const SUPPRESS_NATIVE_PASTE_MS = 100;

// Erase scrollback (3J) + display (2J) and home the cursor. Deliberately NOT
// term.reset(): every pane PTY is a fresh per-client attach whose handshake
// re-asserts terminal modes anyway, but a full RIS would drop them until that
// handshake arrives. The clear only wipes pixels; modes stay up.
const CLEAR_SEQUENCE = "\x1b[3J\x1b[2J\x1b[H";

function preparePastedText(text: string): string {
	return text.replace(/\r?\n/g, "\r");
}

function bracketPastedText(text: string, bracketedPasteMode: boolean): string {
	return bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text;
}

function isTerminalCopyShortcut(event: KeyboardEvent): boolean {
	if (event.key === "Insert") return event.ctrlKey && !event.altKey && !event.metaKey;
	if (event.key.toLowerCase() !== "c") return false;
	if (event.metaKey) return true;
	if (event.ctrlKey && event.shiftKey && !event.altKey) return true;
	return isWindowsPlatform() && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
}

function isWindowsPlatform(): boolean {
	const platform =
		(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
	return platform.toLowerCase().startsWith("win");
}

function isTerminalPasteShortcut(event: KeyboardEvent): boolean {
	if (event.key === "Insert") return event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
	if (event.key.toLowerCase() !== "v") return false;
	if (event.metaKey) return true;
	if (event.ctrlKey && event.shiftKey && !event.altKey) return true;
	return isWindowsPlatform() && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
}

function consumeTerminalShortcut(event: KeyboardEvent): void {
	event.preventDefault();
	event.stopPropagation();
}

function normalizedTerminalShortcut(event: KeyboardEvent): string | null {
	if (event.metaKey || event.shiftKey) return null;

	if (event.altKey && !event.ctrlKey) {
		switch (event.key) {
			case "ArrowLeft":
				return "\x1bb";
			case "ArrowRight":
				return "\x1bf";
			case "Backspace":
				return "\x1b\x7f";
			case "Delete":
				return "\x1bd";
			default:
				return null;
		}
	}

	if (event.ctrlKey && !event.altKey) {
		switch (event.key) {
			case "ArrowLeft":
				return "\x1b[1;5D";
			case "ArrowRight":
				return "\x1b[1;5C";
			case "Backspace":
				return "\x1b\x7f";
			case "Delete":
				return "\x1bd";
			default:
				return null;
		}
	}

	return null;
}

function terminalHasFocus(host: HTMLElement): boolean {
	const activeElement = document.activeElement;
	return !!activeElement && host.contains(activeElement);
}

type XtermInternal = Terminal & {
	_core?: {
		element?: HTMLElement;
		_selectionService?: {
			enable: () => void;
			shouldForceSelection: (event: MouseEvent) => boolean;
		};
	};
};

// For mouse-tracking panes we synthesize SGR mouse-wheel reports and write them
// to the pane; tmux (with `mouse on`, set by the runtime adapter) acts on them
// and scrolls its scrollback via copy-mode. Left to itself xterm would convert
// the wheel into cursor-arrow keys (its alt-buffer fallback), which move the
// agent's cursor rather than scrolling. SGR button 64 = wheel up, 65 = down;
// reports are 1-based and a single cell is enough for a borderless single pane.
const SGR_WHEEL_UP = 64;
const SGR_WHEEL_DOWN = 65;

function sgrWheelReport(button: number, count: number): string {
	return `\x1b[<${button};1;1M`.repeat(count);
}

// PageUp (CSI 5~) / PageDown (CSI 6~) for pane apps that scroll their transcript
// by keyboard rather than mouse reports. One page key per wheel notch: a page
// already scrolls a full screen, so scaling by line count would over-scroll.
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

function pageKeyReport(lines: number): string {
	return lines < 0 ? PAGE_UP : PAGE_DOWN;
}

function forceSelectionMode(term: Terminal): void {
	const internal = term as XtermInternal;
	const selectionService = internal._core?._selectionService;
	const element = internal._core?.element;
	if (!selectionService || !element) return;
	selectionService.shouldForceSelection = () => true;
	selectionService.enable();
	element.classList.remove("enable-mouse-events");
}

export function XtermTerminal(props: XtermTerminalProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const termRef = useRef<Terminal | null>(null);
	const fitRef = useRef<(() => void) | null>(null);
	// Latest callbacks in a ref so the mount effect stays dependency-free — we
	// never tear down and recreate the terminal because a handler identity
	// changed between renders.
	const callbacksRef = useRef(props);

	useEffect(() => {
		callbacksRef.current = props;
	});

	useEffect(() => {
		const term = termRef.current;
		if (!term) return;
		term.options.theme = props.theme === "dark" ? terminalThemes.dark : terminalThemes.light;
	}, [props.theme]);

	useEffect(() => {
		const term = termRef.current;
		if (!term || !props.fontSize) return undefined;
		term.options.fontSize = props.fontSize;
		fitRef.current?.();
		const timer = window.setTimeout(() => fitRef.current?.(), 50);
		return () => window.clearTimeout(timer);
	}, [props.fontSize]);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return undefined;

		let term: Terminal;
		try {
			term = new Terminal({
				// Required for the Unicode 11 width addon below.
				allowProposedApi: true,
				cursorBlink: true,
				// Resolve the Nerd Font stack from --font-mono (styles.css) at
				// construction so terminal glyphs follow the app's font tokens. The
				// box-drawing grid is rasterized by the WebGL/canvas renderer itself,
				// but powerline separators and file-type icons are real PUA codepoints
				// that must come from a system-installed Nerd Font.
				fontFamily:
					getComputedStyle(host).getPropertyValue("--font-mono").trim() ||
					'ui-monospace, Menlo, Monaco, "Courier New", monospace',
				fontSize: props.fontSize ?? 12,
				lineHeight: 1.35,
				// Agent TUIs leave SGR bold active while using ANSI black for
				// separators; keep bold weight-only so black stays black.
				drawBoldTextInBrightColors: false,
				// Auto-adjust glyph colors that don't clear WCAG AA against their cell
				// background, the way VS Code's terminal does; without it dim colors
				// render washed out.
				minimumContrastRatio: 4.5,
				// Alt-buffer panes (tmux attach, mouse-tracking agent TUIs) never feed
				// this buffer — the alt screen doesn't accumulate scrollback — so this
				// only matters for normal-buffer panes that print their transcript and
				// rely on the terminal's scrollback (codex, a plain shell). Keep it > 0
				// so that history survives to be scrolled locally (see the wheel
				// handler's normal-buffer branch). The scrollbar itself is hidden in
				// CSS so FitAddon's ~14px reservation doesn't shift the grid.
				scrollback: 5000,
				theme: props.theme === "dark" ? terminalThemes.dark : terminalThemes.light,
			});
		} catch (error) {
			callbacksRef.current.onError?.(error);
			return undefined;
		}

		termRef.current = term;

		const fit = new FitAddon();
		term.loadAddon(fit);
		const unicode = new Unicode11Addon();
		term.loadAddon(unicode);
		term.unicode.activeVersion = "11";
		// Open links in the OS browser. The default WebLinksAddon handler calls
		// window.open() with no URL and then assigns location.href, but the
		// Electron main process denies every window.open and only forwards the URL
		// passed to it (main.ts setWindowOpenHandler), so the default handler's
		// empty open is dropped and clicks silently no-op. Pass the matched URL to
		// window.open directly so the main process routes it to shell.openExternal.
		term.loadAddon(
			new WebLinksAddon((_event, uri) => {
				window.open(uri, "_blank", "noopener");
			}),
		);
		term.loadAddon(new SearchAddon());

		term.open(host);
		loadRenderer(term);
		term.options.macOptionClickForcesSelection = true;
		forceSelectionMode(term);

		let lastCopiedSelection = "";
		const copySelection = (options?: { clipboardData?: DataTransfer | null; dedupe?: boolean }) => {
			const selection = term.getSelection();
			if (!selection || (options?.dedupe && selection === lastCopiedSelection)) return false;
			options?.clipboardData?.setData("text/plain", selection);
			void aoBridge.clipboard
				.writeText(selection)
				.then(() => {
					lastCopiedSelection = selection;
				})
				.catch((error) => {
					console.warn("Unable to copy terminal selection", error);
				});
			return true;
		};
		const clearCopiedSelection = () => {
			lastCopiedSelection = "";
		};
		const userInputListeners = new Set<(data: string, source: TerminalUserInputSource) => void>();
		const emitUserInput = (data: string, source: TerminalUserInputSource) => {
			if (data.length === 0) return;
			userInputListeners.forEach((listener) => listener(data, source));
		};
		const pasteText = (text: string) => {
			const prepared = preparePastedText(text);
			const bracketed = term.modes.bracketedPasteMode && term.options.ignoreBracketedPasteMode !== true;
			emitUserInput(bracketPastedText(prepared, bracketed), "paste");
		};
		let suppressNextNativePaste = false;
		let suppressPasteTimer: number | null = null;
		const clearSuppressNativePaste = () => {
			suppressNextNativePaste = false;
			if (suppressPasteTimer !== null) {
				window.clearTimeout(suppressPasteTimer);
				suppressPasteTimer = null;
			}
		};
		const suppressNativePasteOnce = () => {
			suppressNextNativePaste = true;
			if (suppressPasteTimer !== null) window.clearTimeout(suppressPasteTimer);
			suppressPasteTimer = window.setTimeout(clearSuppressNativePaste, SUPPRESS_NATIVE_PASTE_MS);
		};
		const pasteFromClipboard = () => {
			void aoBridge.clipboard
				.readText()
				.then(pasteText)
				.catch((error) => {
					console.warn("Unable to paste terminal clipboard text", error);
				});
		};
		term.attachCustomKeyEventHandler((event) => {
			if (isTerminalCopyShortcut(event)) {
				if (copySelection()) {
					consumeTerminalShortcut(event);
					return false;
				}
				if ((event.ctrlKey && event.shiftKey) || (event.key === "Insert" && event.ctrlKey)) {
					consumeTerminalShortcut(event);
					return false;
				}
				return true;
			}
			if (isTerminalPasteShortcut(event)) {
				consumeTerminalShortcut(event);
				suppressNativePasteOnce();
				pasteFromClipboard();
				return false;
			}
			const normalized = normalizedTerminalShortcut(event);
			if (!normalized) return true;
			consumeTerminalShortcut(event);
			emitUserInput(normalized, "shortcut");
			return false;
		});
		const copyInput = (event: ClipboardEvent) => {
			if (!copySelection({ clipboardData: event.clipboardData })) return;
			event.preventDefault();
		};
		const copyShortcut = (event: KeyboardEvent) => {
			if (!isTerminalCopyShortcut(event) || !terminalHasFocus(host) || !copySelection()) return;
			event.preventDefault();
			event.stopPropagation();
		};
		host.addEventListener("copy", copyInput);
		window.addEventListener("keydown", copyShortcut, true);
		const selectionChange = term.onSelectionChange(() => {
			if (!term.hasSelection()) {
				clearCopiedSelection();
				return;
			}
			window.setTimeout(() => copySelection({ dedupe: true }), 0);
		});

		const fitTerminal = () => {
			try {
				fit.fit();
			} catch {
				// Container momentarily has no size (hidden/unmounting) — a later
				// trigger retries.
			}
		};
		fitRef.current = fitTerminal;

		const raf = requestAnimationFrame(fitTerminal);
		// 50/250ms catch the common settle; 600/1200ms are a session-bounded
		// backstop. By 600ms the WebGL atlas and font metrics are unambiguously
		// warm, so even if the convergence loop below detached at a briefly-stable
		// wrong measurement, this re-measures the real cell box and corrects,
		// firing the PTY resize that makes the pane repaint cleanly (clearing
		// any ghost frame). fit() is idempotent: a no-op when the grid is already
		// right, so a correct terminal never reflows.
		const settleTimers = [50, 250, 600, 1200].map((ms) => window.setTimeout(fitTerminal, ms));
		if (document.fonts?.ready) {
			void document.fonts.ready.then(fitTerminal);
		}
		const observer = new ResizeObserver(fitTerminal);
		observer.observe(host);

		// Recovery re-fit that does NOT depend on the host box changing size.
		//
		// FitAddon derives the grid by dividing the pane box by the renderer's
		// measured cell box. That box is measured asynchronously: the WebGL
		// renderer loads after open() and the monospace font's real metrics
		// resolve a frame or more later, so the early fits above can divide by a
		// not-yet-final cell box, mis-count cols/rows, and clip the grid inside the
		// pane. The fixed settle window (rAF, timeouts, fonts.ready) may all run
		// before the cell box is final, and the ResizeObserver never fires to
		// correct it because the host's pixel box is a stable height:100%, so a
		// wrong grid would otherwise freeze for the whole session.
		//
		// onRender fires on every renderer repaint, including the repaint after
		// the metrics settle. Each fire re-proposes dimensions from the *current*
		// measured cell box. Crucially we never re-fit straight off a single
		// frame's proposal: the WebGL atlas warm-up can emit a one-frame transient
		// cell box (e.g. a doubled box on a HiDPI display) that halves the grid,
		// and committing it would lock the terminal at half size and detach (the
		// #313 ghost). So a differing proposal must REPEAT identically across two
		// consecutive renders — proving the measurement settled — before we apply
		// it. proposeDimensions returns undefined until the cell box is non-zero,
		// so a fit is never accepted from an unmeasured cell. Once the proposal
		// holds at the live grid for a few frames (or a hard re-fit cap is hit) the
		// listener detaches, so steady-state content renders cost nothing.
		const STABLE_FRAMES_TARGET = 3;
		const MAX_REFITS = 20;
		let stableFrames = 0;
		let refits = 0;
		let pending: { cols: number; rows: number } | null = null;
		const stabilizer = term.onRender(() => {
			const proposed = fit.proposeDimensions();
			if (!proposed || !proposed.cols || !proposed.rows) return;
			if (proposed.cols !== term.cols || proposed.rows !== term.rows) {
				stableFrames = 0;
				// Only act once the same differing proposal repeats — a single-frame
				// transient never gets committed, it just updates `pending`.
				if (pending && pending.cols === proposed.cols && pending.rows === proposed.rows) {
					pending = null;
					if (refits++ >= MAX_REFITS) {
						stabilizer.dispose();
						return;
					}
					fitTerminal();
					return;
				}
				pending = { cols: proposed.cols, rows: proposed.rows };
				return;
			}
			pending = null;
			if (++stableFrames >= STABLE_FRAMES_TARGET) stabilizer.dispose();
		});

		// OS window resize and monitor/DPR changes also alter the true cell box
		// without touching the host's height:100% box, so the ResizeObserver above
		// misses them. Listen on window directly as a session-long recovery path.
		window.addEventListener("resize", fitTerminal);

		// Do not replace this with term.onData. xterm's raw data stream can include
		// terminal-generated control responses during attach/repaint; forwarding
		// those bytes through the mux writes dirty input into the real Codex PTY and
		// corrupts the TUI. Keyboard is the only safe generic text path here; paste,
		// composition, shortcuts, and wheel reports are emitted explicitly below.
		const keyInput = term.onKey(({ key }) => emitUserInput(key, "keyboard"));

		// Translate wheel motion into SGR wheel reports for the pane (see
		// sgrWheelReport), one report per scrolled line. WheelEvent.deltaMode
		// varies by platform/device: trackpads and normalized wheels report
		// pixels (mode 0, the macOS case), while many Linux/Windows mouse wheels
		// report whole lines (mode 1) or pages (mode 2). Mirror xterm's native
		// getLinesScrolled across all three so scroll works everywhere; pixel
		// deltas accumulate so a full cell-height emits one line. Returning false
		// suppresses xterm's arrow-key wheel fallback. Ctrl/Cmd wheel is the
		// font-size zoom (CenterPane), so leave it for that handler.
		let wheelAccumPx = 0;
		term.attachCustomWheelEventHandler((event) => {
			if (event.ctrlKey || event.metaKey) return false;
			let lines: number;
			if (event.deltaMode === 1 /* DOM_DELTA_LINE */) {
				lines = Math.trunc(event.deltaY) || Math.sign(event.deltaY);
			} else if (event.deltaMode === 2 /* DOM_DELTA_PAGE */) {
				lines = (Math.trunc(event.deltaY) || Math.sign(event.deltaY)) * term.rows;
			} else {
				const rowHeight = (term.options.fontSize ?? 12) * (term.options.lineHeight ?? 1);
				wheelAccumPx += event.deltaY;
				lines = Math.trunc(wheelAccumPx / rowHeight);
				wheelAccumPx -= lines * rowHeight;
			}
			if (lines === 0) return false;
			// A full-screen TUI that keeps its own transcript and scrolls it only by
			// keyboard (opencode) ignores wheel/mouse reports on every platform; route
			// its wheel to page keys. Kept first so opencode is unaffected by the
			// buffer-aware paths below.
			if (callbacksRef.current.paneScrollsByKeyboard) {
				emitUserInput(pageKeyReport(lines), "wheel");
				return false;
			}
			// A normal-buffer pane with mouse tracking off (codex, a plain shell)
			// prints its transcript and relies on the terminal's own scrollback — the
			// way it scrolls in a raw terminal. Scroll xterm's viewport locally; the
			// pane never sees these bytes. Requires scrollback > 0 (see Terminal opts).
			if (term.modes.mouseTrackingMode === "none" && term.buffer.active.type === "normal") {
				term.scrollLines(lines);
				return false;
			}
			// Mouse tracking on: the pane (tmux/zellij copy-mode, or any app that
			// tracks the mouse) acts on SGR wheel reports. On Windows conpty this
			// reaches the app directly; under a mux it drives copy-mode.
			if (term.modes.mouseTrackingMode !== "none") {
				const button = lines < 0 ? SGR_WHEEL_UP : SGR_WHEEL_DOWN;
				emitUserInput(sgrWheelReport(button, Math.abs(lines)), "wheel");
				return false;
			}
			// Alt-buffer pane with mouse tracking off and no keyboard-scroll hint:
			// no scrollback to move locally, so fall back to page keys.
			emitUserInput(pageKeyReport(lines), "wheel");
			return false;
		});
		const pasteInput = (event: ClipboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (suppressNextNativePaste) {
				clearSuppressNativePaste();
				return;
			}
			const text = event.clipboardData?.getData("text/plain") ?? "";
			pasteText(text);
		};
		const compositionInput = (event: CompositionEvent) => {
			emitUserInput(event.data, "composition");
		};
		host.addEventListener("paste", pasteInput, true);
		host.addEventListener("compositionend", compositionInput, true);

		// Live cols/rows getters: the owner reads the current grid at attach time,
		// not a snapshot taken at ready time (the first fit may not have run yet).
		const handle: AttachableTerminal = {
			get cols() {
				return term.cols;
			},
			get rows() {
				return term.rows;
			},
			write: (data) => term.write(data),
			writeln: (line) => term.writeln(line),
			clear: () => term.write(CLEAR_SEQUENCE),
			onUserInput: (listener) => {
				userInputListeners.add(listener);
				return { dispose: () => userInputListeners.delete(listener) };
			},
			onResize: (listener) => term.onResize(listener),
		};
		callbacksRef.current.onReady?.(handle);

		return () => {
			termRef.current = null;
			fitRef.current = null;
			cancelAnimationFrame(raf);
			for (const timer of settleTimers) window.clearTimeout(timer);
			observer.disconnect();
			stabilizer.dispose();
			window.removeEventListener("resize", fitTerminal);
			host.removeEventListener("copy", copyInput);
			window.removeEventListener("keydown", copyShortcut, true);
			selectionChange.dispose();
			host.removeEventListener("paste", pasteInput, true);
			host.removeEventListener("compositionend", compositionInput, true);
			clearSuppressNativePaste();
			keyInput.dispose();
			userInputListeners.clear();
			try {
				term.dispose();
			} catch {
				// Some renderer addons can throw during dispose in certain GPU
				// environments; the terminal is being torn down regardless.
			}
		};
	}, []);

	return (
		<div
			ref={hostRef}
			aria-label={props.ariaLabel}
			className={props.className}
			style={{ height: "100%", overflow: "hidden", width: "100%" }}
		/>
	);
}
