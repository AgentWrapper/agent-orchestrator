// Real browser terminal for the web target - a port of the Electron
// renderer's XtermTerminal (frontend/src/renderer/components/XtermTerminal.tsx),
// the hardened reference for driving xterm.js against the AO daemon's mux.
// Keep the two in sync when fixing bugs; the design rules are identical:
//
//  - The mount effect is dependency-free: the terminal instance is created
//    once per mount and NEVER torn down because a callback identity changed.
//    Latest props live in a ref.
//  - Nothing writes into the buffer at mount. Status/empty-state belongs to
//    chrome around the terminal, owned by the screen.
//  - Fitting runs on several triggers (rAF, settle timeouts, fonts.ready,
//    ResizeObserver, an onRender convergence loop, window resize) because
//    FitAddon can measure before the font metrics / WebGL atlas settle and
//    would otherwise freeze a clipped grid for the whole session.
//  - Input is NOT term.onData: xterm's raw data stream can include
//    terminal-generated control responses during attach/repaint, and
//    forwarding those through the mux corrupts the real PTY. Keyboard,
//    paste, composition, shortcuts, and wheel reports are emitted explicitly
//    through one listener set.
//
// Adaptations from the renderer version (the only intended differences):
//  - Clipboard: navigator.clipboard instead of Electron's aoBridge. In
//    insecure contexts (plain http on a LAN host) the async API is absent
//    and copy/paste degrade to the native ClipboardEvent path.
//  - Links: window.open works natively in a browser; no Electron routing.
//  - Theme: the app is dark-only, so one palette built from lib/theme.ts
//    replaces the light/dark theme store.

import "@xterm/xterm/css/xterm.css";

import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { theme } from "./theme";
// Type-only import of the platform seam (WebTerminal.tsx). Erased at compile
// time, so Metro never sees a runtime self-import from the web file; tsc
// resolves the bare specifier to WebTerminal.tsx, keeping one contract.
import type { WebTerminalHandle, WebTerminalProps, WebTerminalUserInputSource } from "./WebTerminal";

// Prefer the WebGL renderer, fall back to 2D canvas. Both rasterize
// box-drawing glyphs themselves onto a fixed cell grid; the DOM renderer does
// not, so TUI borders would drift. Loaded after open().
function loadRenderer(term: Terminal): void {
	try {
		const webgl = new WebglAddon();
		webgl.onContextLoss(() => webgl.dispose());
		term.loadAddon(webgl);
		return;
	} catch {
		// WebGL context unavailable - fall through to the canvas renderer.
	}
	try {
		term.loadAddon(new CanvasAddon());
	} catch (error) {
		console.warn("xterm: WebGL and canvas renderers unavailable; box-drawing may drift", error);
	}
}

// One dark palette from the mobile tokens - matches the native terminal's
// xtermOptions in app/session/[id].tsx so both targets read identically.
// The ANSI 16 stay xterm defaults; pane content is the agent's own output.
const TERMINAL_THEME = {
	background: theme.term,
	foreground: theme.textPrimary,
	cursor: theme.orange,
};

const SUPPRESS_NATIVE_PASTE_MS = 100;

// Erase scrollback (3J) + display (2J) and home the cursor. Deliberately NOT
// term.reset(): every pane PTY is a fresh per-client attach whose handshake
// re-asserts terminal modes anyway, but a full RIS would drop them until that
// handshake arrives. The clear only wipes pixels; modes stay up.
const CLEAR_SEQUENCE = "\x1b[3J\x1b[2J\x1b[H";

// navigator.clipboard is typed non-optional but is absent at runtime in
// insecure contexts (plain http on a LAN/proxy host), and some browsers omit
// readText. Probe per method; callers degrade to the ClipboardEvent path.
function clipboardWrite(): ((text: string) => Promise<void>) | null {
	const c = typeof navigator !== "undefined" ? (navigator.clipboard as Clipboard | undefined) : undefined;
	return c && typeof c.writeText === "function" ? c.writeText.bind(c) : null;
}

function clipboardRead(): (() => Promise<string>) | null {
	const c = typeof navigator !== "undefined" ? (navigator.clipboard as Clipboard | undefined) : undefined;
	return c && typeof c.readText === "function" ? c.readText.bind(c) : null;
}

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

// We never scroll locally (scrollback:0). Instead we synthesize SGR
// mouse-wheel reports and write them to the pane; tmux (with `mouse on`, set
// by the runtime adapter) acts on them and scrolls its scrollback via
// copy-mode. With scrollback:0 xterm would otherwise convert the wheel into
// cursor-arrow keys (its alt-buffer fallback), which move the agent's cursor
// rather than scrolling. SGR button 64 = wheel up, 65 = down; reports are
// 1-based and a single cell is enough for a borderless single pane.
const SGR_WHEEL_UP = 64;
const SGR_WHEEL_DOWN = 65;

function sgrWheelReport(button: number, count: number): string {
	return `\x1b[<${button};1;1M`.repeat(count);
}

// PageUp (CSI 5~) / PageDown (CSI 6~) for pane apps that scroll their
// transcript by keyboard rather than mouse reports. One page key per wheel
// notch: a page already scrolls a full screen.
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

export function WebTerminal(props: WebTerminalProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const termRef = useRef<Terminal | null>(null);
	const fitRef = useRef<(() => void) | null>(null);
	// Latest callbacks in a ref so the mount effect stays dependency-free - we
	// never tear down and recreate the terminal because a handler identity
	// changed between renders.
	const callbacksRef = useRef(props);

	useEffect(() => {
		callbacksRef.current = props;
	});

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
				fontFamily: theme.fontMono,
				fontSize: props.fontSize ?? 12,
				lineHeight: 1.35,
				// Agent TUIs leave SGR bold active while using ANSI black for
				// separators; keep bold weight-only so black stays black.
				drawBoldTextInBrightColors: false,
				// Auto-adjust glyph colors that don't clear WCAG AA against their
				// cell background, the way VS Code's terminal does; without it dim
				// colors render washed out.
				minimumContrastRatio: 4.5,
				// The pane PTY runs a full-screen alt-buffer app (tmux attach) that
				// owns scrollback itself, so xterm's own buffer never accumulates
				// history and wheel events are forwarded as mouse reports instead
				// of scrolling locally. 0 also stops FitAddon reserving ~14px on
				// the right for a scrollbar that can never appear. Deliberately NOT
				// the native app's scrollback:5000 (its WebView xterm scrolls
				// locally by touch).
				scrollback: 0,
				theme: TERMINAL_THEME,
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
		// window.open is native in a browser (unlike the Electron renderer,
		// which must route it through the main process); open in a new tab.
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
			// ClipboardEvent path: works even without the async clipboard API.
			options?.clipboardData?.setData("text/plain", selection);
			const write = clipboardWrite();
			if (!write) {
				// No async API (insecure context). If a native copy event carried
				// us here, setData above already copied; otherwise report failure
				// so the caller leaves the native copy event un-consumed.
				if (!options?.clipboardData) return false;
				lastCopiedSelection = selection;
				return true;
			}
			void write(selection)
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
		const userInputListeners = new Set<(data: string, source: WebTerminalUserInputSource) => void>();
		const emitUserInput = (data: string, source: WebTerminalUserInputSource) => {
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
			const read = clipboardRead();
			if (!read) return;
			void read()
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
				// No async read (insecure context): don't consume - the browser's
				// native paste event fires instead and pasteInput handles it.
				if (!clipboardRead()) return true;
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
				// Container momentarily has no size (hidden/unmounting) - a later
				// trigger retries.
			}
		};
		fitRef.current = fitTerminal;

		const raf = requestAnimationFrame(fitTerminal);
		// 50/250ms catch the common settle; 600/1200ms are a session-bounded
		// backstop. By 600ms the WebGL atlas and font metrics are unambiguously
		// warm, so even if the convergence loop below detached at a
		// briefly-stable wrong measurement, this re-measures the real cell box
		// and corrects. fit() is idempotent: a no-op when the grid is right.
		const settleTimers = [50, 250, 600, 1200].map((ms) => window.setTimeout(fitTerminal, ms));
		if (document.fonts?.ready) {
			void document.fonts.ready.then(fitTerminal);
		}
		const observer = new ResizeObserver(fitTerminal);
		observer.observe(host);

		// Recovery re-fit that does NOT depend on the host box changing size.
		// FitAddon divides the pane box by the renderer's measured cell box,
		// which settles asynchronously (WebGL loads after open(), font metrics
		// resolve a frame later). A differing proposal must REPEAT identically
		// across two consecutive renders before we apply it - a single-frame
		// transient (e.g. a doubled cell box during atlas warm-up on HiDPI)
		// never gets committed. Once the proposal holds at the live grid for a
		// few frames (or the re-fit cap is hit) the listener detaches. See the
		// renderer's XtermTerminal for the full history of this loop.
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
		// without touching the host's box, so the ResizeObserver above misses
		// them. Listen on window directly as a session-long recovery path.
		window.addEventListener("resize", fitTerminal);

		// Do not replace this with term.onData (see the header comment).
		const keyInput = term.onKey(({ key }) => emitUserInput(key, "keyboard"));

		// Translate wheel motion into SGR wheel reports for the pane, one report
		// per scrolled line. WheelEvent.deltaMode varies by platform/device:
		// trackpads report pixels (mode 0), many mouse wheels report lines
		// (mode 1) or pages (mode 2); pixel deltas accumulate so a full
		// cell-height emits one line. Returning false suppresses xterm's
		// arrow-key wheel fallback. Ctrl/Cmd wheel is left alone (browser zoom).
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
			// The SGR wheel path drives tmux/zellij copy-mode. It cannot scroll a
			// full-screen TUI that keeps its own transcript and only scrolls on
			// PageUp/PageDown (opencode). Send page keys for such apps
			// (paneScrollsByKeyboard), on Windows (conpty has no mux), and for
			// any pane app with mouse tracking fully off.
			if (
				callbacksRef.current.paneScrollsByKeyboard ||
				isWindowsPlatform() ||
				term.modes.mouseTrackingMode === "none"
			) {
				emitUserInput(pageKeyReport(lines), "wheel");
				return false;
			}
			const button = lines < 0 ? SGR_WHEEL_UP : SGR_WHEEL_DOWN;
			emitUserInput(sgrWheelReport(button, Math.abs(lines)), "wheel");
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

		// Live cols/rows getters: the owner reads the current grid at attach
		// time, not a snapshot taken at ready time (the first fit may not have
		// run yet).
		const handle: WebTerminalHandle = {
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
		// The terminal is the screen's single input surface on web; focus it so
		// keys flow without an extra click (the renderer's pane manager does
		// this from outside).
		term.focus();
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

	// Absolute-fill inside the screen's termWrap View (React Native views are
	// position:relative by default), so the host box is always definite - no
	// height:100% resolution quirks inside a flex column.
	return (
		<div
			ref={hostRef}
			aria-label={props.ariaLabel}
			style={{
				position: "absolute",
				top: 0,
				right: 0,
				bottom: 0,
				left: 0,
				overflow: "hidden",
				backgroundColor: theme.term,
			}}
		/>
	);
}
