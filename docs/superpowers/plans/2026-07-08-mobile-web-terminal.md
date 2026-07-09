# Mobile Web Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `packages/mobile` Expo app a real, interactive xterm.js terminal on its web target (replacing the "phone-only" placeholder), plus an Origin-rewriting LAN proxy so a browser on another machine can reach the daemon.

**Architecture:** Three independent pieces. (A) `lib/WebTerminal.web.tsx` — a browser-DOM xterm.js surface ported from the Electron renderer's hardened `XtermTerminal.tsx`, with a type-carrying native stub at `lib/WebTerminal.tsx`. (B) `app/session/[id].tsx` routes the existing `MuxClient` I/O to that surface on web. (C) `scripts/ao-phone-proxy.js` becomes an HTTP-aware reverse proxy that rewrites `Origin`/`Access-Control-Allow-Origin` so a remote browser passes the daemon's CORS guard.

**Tech Stack:** Expo SDK 54 (Metro web bundler), react-native-web 0.21, `@xterm/xterm` 5.5 + fit/webgl/canvas/unicode11/search/web-links addons (same versions as `frontend/`), Node built-ins only for the proxy.

**Spec:** `docs/superpowers/specs/2026-07-08-mobile-web-terminal-design.md`. Port source: `frontend/src/renderer/components/XtermTerminal.tsx` (595 lines) and `frontend/src/renderer/hooks/useTerminalSession.ts`.

## Global Constraints

- Branch: `mobile-web-terminal` (already checked out). All work lands there.
- xterm dependency ranges must match `frontend/package.json` exactly: `@xterm/xterm ^5.5.0`, `@xterm/addon-fit ^0.10.0`, `@xterm/addon-webgl ^0.19.0`, `@xterm/addon-canvas ^0.7.0`, `@xterm/addon-unicode11 ^0.9.0`, `@xterm/addon-search ^0.15.0`, `@xterm/addon-web-links ^0.11.0`.
- The proxy uses Node built-ins only (`http`, `net`, `fs`, `os`, `path`). No new npm dependencies for it.
- The native terminal path is untouchable: `XtermJsWebView`, its `TERMINAL_ENHANCE_JS`, `xtermOptions` (`scrollback: 5000`), the hidden `TextInput` keyboard flow on ios/android all stay exactly as they are.
- The web terminal MUST use `scrollback: 0` (daemon panes are tmux-attach alt-buffer apps that own scrollback; wheel becomes SGR reports). This deliberately differs from the native app's `scrollback: 5000`.
- No `metro.config.js`, `babel.config.js`, or `app.json` changes.
- Package manager is **npm** (`package-lock.json` is the tracked lockfile). Never commit `pnpm-lock.yaml` (root or `packages/mobile/` — both are untracked accidents; leave them alone).
- Never `git add` `frontend/src/renderer/routeTree.gen.ts` — it churns while a dev server runs and is not part of this work. Always `git add` specific paths, never `-A`/`.`.
- Code style: tab indentation, double quotes, same comment density as the surrounding files. TypeScript `strict` is on.
- App state stays under `~/.ao` (the proxy's default `STATE` path already complies).
- Out of scope (do NOT build): an in-terminal search box UI (SearchAddon loads for parity only), touch/gesture scrolling on web, daemon auth/TLS changes, any change to the native terminal.

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `packages/mobile/package.json` | modify | Add xterm deps, web deps, `"web"` script |
| `packages/mobile/images.d.ts` | modify | Add `declare module "*.css"` so tsc accepts the xterm CSS import |
| `packages/mobile/lib/WebTerminal.tsx` | create | Platform seam: shared `WebTerminalHandle`/`WebTerminalProps` types + native no-op stub. **This is what tsc resolves** |
| `packages/mobile/lib/WebTerminal.web.tsx` | create | Real xterm.js surface (port of `XtermTerminal.tsx`). **This is what Metro resolves on web** |
| `packages/mobile/app/session/[id].tsx` | modify | Route mux I/O to the web terminal on web; suppress phone keyboard chrome; re-enable dead/Restore overlay |
| `packages/mobile/scripts/ao-phone-proxy.js` | rewrite | HTTP-aware reverse proxy: Origin/ACAO rewrite + preflight + WS upgrade replay, TOFU preserved |
| `packages/mobile/scripts/ao-phone-proxy.test.js` | create | No-dep Node self-check against a mocked upstream daemon |
| `packages/mobile/README.md` | modify | Web target docs |
| `packages/mobile/scripts/README.md` | modify | Browser-over-proxy docs |

**Deviation from the spec (deliberate, verified):** the spec names the stub `WebTerminal.native.tsx`. That layout breaks `npm run typecheck`: `expo/tsconfig.base` (SDK 54) uses `moduleResolution: "bundler"` with **no `moduleSuffixes`**, so tsc cannot resolve `./WebTerminal` if only `.native.tsx`/`.web.tsx` exist. Instead the stub is the plain `WebTerminal.tsx`: Metro on ios/android falls back to `.tsx` (no `.native.tsx` needed), Metro on web picks `.web.tsx`, and tsc resolves `.tsx` — one file serves as both native stub and the single type contract. The spec's actual goal (xterm never bundled into the native app) still holds: only `WebTerminal.web.tsx` imports xterm.

**Baseline state:** the working tree already contains uncommitted changes to `app/session/[id].tsx` (the interim "phone-only" panel + `<iframe>` preview + `reloadPreview`). Task 1 commits them first so every later edit in this plan matches a known file state. All `[id].tsx` snippets in Task 3 are exact matches against that baseline (tabs, not spaces).

---

### Task 1: Baseline commit + dependencies

**Files:**
- Modify: `packages/mobile/package.json`
- Commit (pre-existing edits): `packages/mobile/app/session/[id].tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: installed `@xterm/*` packages importable from `packages/mobile`, `npm run web` script. Later tasks assume `import { Terminal } from "@xterm/xterm"` resolves.

- [ ] **Step 1: Commit the interim web-fallback baseline**

The working tree has uncommitted `[id].tsx` changes (phone-only panel, iframe preview). Commit ONLY that file:

```bash
cd /Users/amongstar/dev/agent-orchestrator
git add "packages/mobile/app/session/[id].tsx"
git commit -m "feat(mobile): web fallback panel + iframe preview on web target"
```

Expected: 1 file changed. `git status` may still show `frontend/src/renderer/routeTree.gen.ts` modified and two `pnpm-lock.yaml` files untracked — leave all three alone for the rest of the plan.

- [ ] **Step 2: Install web + xterm dependencies**

```bash
cd /Users/amongstar/dev/agent-orchestrator/packages/mobile
npx expo install react-dom react-native-web @expo/metro-runtime
npm install "@xterm/xterm@^5.5.0" "@xterm/addon-fit@^0.10.0" "@xterm/addon-webgl@^0.19.0" "@xterm/addon-canvas@^0.7.0" "@xterm/addon-unicode11@^0.9.0" "@xterm/addon-search@^0.15.0" "@xterm/addon-web-links@^0.11.0"
```

`expo install` picks SDK-compatible versions (currently react-dom 19.1.0, react-native-web 0.21.2, @expo/metro-runtime 6.1.2 — already physically present in `node_modules`, just unlisted in `package.json`). Accept whatever ranges expo writes for those three; the seven `@xterm/*` ranges must be exactly as above.

- [ ] **Step 3: Add the web script**

In `packages/mobile/package.json`, change:

```json
	"scripts": {
		"start": "expo start",
		"android": "expo start --android",
		"ios": "expo start --ios",
		"typecheck": "tsc --noEmit",
		"build": "npm run typecheck"
	},
```

to:

```json
	"scripts": {
		"start": "expo start",
		"android": "expo start --android",
		"ios": "expo start --ios",
		"web": "expo start --web",
		"typecheck": "tsc --noEmit",
		"build": "npm run typecheck"
	},
```

- [ ] **Step 4: Verify install and types**

```bash
cd /Users/amongstar/dev/agent-orchestrator/packages/mobile
npm ls @xterm/xterm react-native-web react-dom @expo/metro-runtime
npm run typecheck
```

Expected: `npm ls` shows all four resolved (no `UNMET`); typecheck exits 0 with no output after the tsc banner.

- [ ] **Step 5: Commit**

```bash
cd /Users/amongstar/dev/agent-orchestrator
git add packages/mobile/package.json packages/mobile/package-lock.json
git commit -m "chore(mobile): add xterm + web deps and web script"
```

---

### Task 2: WebTerminal — the browser xterm surface

**Files:**
- Modify: `packages/mobile/images.d.ts`
- Create: `packages/mobile/lib/WebTerminal.tsx`
- Create: `packages/mobile/lib/WebTerminal.web.tsx`

**Interfaces:**
- Consumes: `theme` from `packages/mobile/lib/theme.ts` (`theme.term`, `theme.textPrimary`, `theme.orange`, `theme.fontMono`); `@xterm/*` packages from Task 1.
- Produces (Task 3 relies on these exact names, from `"../../lib/WebTerminal"`):
  - `WebTerminal(props: WebTerminalProps)` — React component (named export in BOTH files).
  - `type WebTerminalProps = { ariaLabel?: string; fontSize?: number; paneScrollsByKeyboard?: boolean; onError?: (error: unknown) => void; onReady?: (terminal: WebTerminalHandle) => void }`
  - `type WebTerminalHandle = { readonly cols: number; readonly rows: number; write(data: Uint8Array): void; writeln(line: string): void; clear(): void; onUserInput(listener: (data: string, source: WebTerminalUserInputSource) => void): { dispose(): void }; onResize(listener: (size: { cols: number; rows: number }) => void): { dispose(): void } }`
  - `type WebTerminalUserInputSource = "keyboard" | "paste" | "composition" | "shortcut" | "wheel"`

There is no test runner in `packages/mobile` (and the spec scopes automated verification to `tsc`); the behavioral contract is exercised by Task 5's live checklist. Verification within this task = typecheck.

- [ ] **Step 1: Let tsc accept CSS imports**

Append to `packages/mobile/images.d.ts` (after the existing `*.png` block):

```ts

// Global CSS imports (Metro supports them on web; native never sees the
// importing file because only *.web.tsx imports CSS).
declare module "*.css";
```

- [ ] **Step 2: Create the platform seam / native stub**

Create `packages/mobile/lib/WebTerminal.tsx` with exactly:

```tsx
// Platform seam for the session terminal's web surface.
//
// Metro resolves `./WebTerminal` per platform:
//   web           -> WebTerminal.web.tsx (the real xterm.js surface)
//   ios / android -> this file (plain .tsx is the fallback; no .native.tsx)
// tsc (moduleResolution "bundler", no moduleSuffixes in expo/tsconfig.base)
// also resolves the bare specifier to THIS file, so the types below are the
// single contract shared by importers and the web implementation. Do not
// rename this to WebTerminal.native.tsx - that breaks `npm run typecheck`.
//
// Native screens never render this (ios/android use XtermJsWebView), and
// because xterm is only imported from WebTerminal.web.tsx, no @xterm package
// ever lands in a native bundle.

export type WebTerminalUserInputSource = "keyboard" | "paste" | "composition" | "shortcut" | "wheel";

export type WebTerminalHandle = {
	/** Live grid getters - read at attach time, never a stale snapshot. */
	readonly cols: number;
	readonly rows: number;
	write: (data: Uint8Array) => void;
	writeln: (line: string) => void;
	/**
	 * Erase screen + scrollback and home the cursor, preserving terminal
	 * modes. Never a full reset (RIS): the fresh attach's handshake re-asserts
	 * modes, but a RIS would drop mouse tracking until it arrives.
	 */
	clear: () => void;
	onUserInput: (listener: (data: string, source: WebTerminalUserInputSource) => void) => { dispose: () => void };
	onResize: (listener: (size: { cols: number; rows: number }) => void) => { dispose: () => void };
};

export type WebTerminalProps = {
	ariaLabel?: string;
	fontSize?: number;
	/**
	 * The pane app scrolls its transcript by keyboard (PageUp/PageDown) rather
	 * than acting on SGR wheel reports - e.g. opencode. Routes the wheel to
	 * page keys instead of mouse reports.
	 */
	paneScrollsByKeyboard?: boolean;
	/** Terminal construction failed; the owner decides how to surface it. */
	onError?: (error: unknown) => void;
	/**
	 * The terminal is open in the DOM and ready to be attached to a PTY. The
	 * handle stays valid until unmount; cols/rows are live getters.
	 */
	onReady?: (terminal: WebTerminalHandle) => void;
};

// Native stub: the real implementation lives in WebTerminal.web.tsx.
export function WebTerminal(_props: WebTerminalProps) {
	return null;
}
```

- [ ] **Step 3: Create the web implementation**

Create `packages/mobile/lib/WebTerminal.web.tsx` with exactly the following. This is a port of `frontend/src/renderer/components/XtermTerminal.tsx`; the only intended differences are the ones listed in the header comment. When in doubt during review, diff against the renderer file — everything else should match it structurally.

```tsx
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
```

- [ ] **Step 4: Typecheck**

```bash
cd /Users/amongstar/dev/agent-orchestrator/packages/mobile
npm run typecheck
```

Expected: exit 0, no errors. (The `.web.tsx` file compiles because `expo/tsconfig.base` includes `lib: ["DOM", "ESNext"]`; the raw `<div>` JSX is fine — `[id].tsx` already renders an `<iframe>` and passes.)

- [ ] **Step 5: Commit**

```bash
cd /Users/amongstar/dev/agent-orchestrator
git add packages/mobile/images.d.ts packages/mobile/lib/WebTerminal.tsx packages/mobile/lib/WebTerminal.web.tsx
git commit -m "feat(mobile): WebTerminal - browser xterm surface for the web target"
```

---

### Task 3: Wire the web terminal into the session screen

**Files:**
- Modify: `packages/mobile/app/session/[id].tsx` (baseline = the commit from Task 1 Step 1)
- Modify: `packages/mobile/README.md`

**Interfaces:**
- Consumes (from Task 2, module `"../../lib/WebTerminal"`): `WebTerminal` component, `WebTerminalHandle` type — `handle.cols`/`handle.rows` (live getters), `handle.write(bytes: Uint8Array)`, `handle.clear()`, `handle.onUserInput(cb)`, `handle.onResize(cb)`.
- Consumes (existing, unchanged): `MuxClient.openTerminal(id, projectId?)`, `.sendInput(id, data, projectId?)`, `.resize(id, cols, rows, projectId?)`; `applyDims(cols, rows)` (records `lastDimsRef`, updates the dims chip, sends `mux.resize` when `openedRef.current`).
- Produces: nothing consumed downstream; this completes the local-web feature.

Every edit below is an exact-match replacement against the Task 1 baseline. **Indentation is tabs** — copy the snippets exactly.

- [ ] **Step 1: Import the component**

Replace:

```tsx
import { theme } from "../../lib/theme";
```

with:

```tsx
import { theme } from "../../lib/theme";
import { WebTerminal, type WebTerminalHandle } from "../../lib/WebTerminal";
```

- [ ] **Step 2: Hoist `isWeb` to module scope**

It is needed by hooks that run before the current mid-component definition. Replace:

```tsx
const FONT_SIZE = 12;
```

with:

```tsx
const FONT_SIZE = 12;

// Platform seam: on web the native WebView can't run (react-native-webview
// resolves to a stub), so the screen swaps in the DOM terminal
// (lib/WebTerminal.web.tsx) and an <iframe> preview. Platform.OS is constant
// for the app's lifetime, so branching hooks/refs/JSX on it is safe.
const isWeb = Platform.OS === "web";
```

Then delete the old in-component definition — replace:

```tsx
	// The terminal and preview render inside a native WebView, which the web target
	// can't run - react-native-webview resolves to a stub that just prints "React
	// Native WebView does not support this platform." Gate both off web.
	const isWeb = Platform.OS === "web";

	// The composer and key bar sit directly atop each other, so they share one
```

with:

```tsx
	// The composer and key bar sit directly atop each other, so they share one
```

- [ ] **Step 3: Add the web terminal refs**

Replace:

```tsx
	// The REAL keyboard input. The WebView can't show/control a keyboard reliably,
	// so this hidden RN TextInput is what raises the keyboard and captures typing,
	// which we forward to the PTY over the mux. Focus it to type, blur it to hide.
	const kbInputRef = useRef<TextInput | null>(null);
```

with:

```tsx
	// The REAL keyboard input. The WebView can't show/control a keyboard reliably,
	// so this hidden RN TextInput is what raises the keyboard and captures typing,
	// which we forward to the PTY over the mux. Focus it to type, blur it to hide.
	// (Native only - on web xterm's own textarea owns keyboard focus.)
	const kbInputRef = useRef<TextInput | null>(null);
	// Web target: the real xterm.js surface (native uses the WebView instead).
	const webTermRef = useRef<WebTerminalHandle | null>(null);
	// Trailing debounce for web grid changes: a window drag emits a burst of
	// onResize events; the PTY should get one resize when the burst settles,
	// then one re-assert frame (mirrors the renderer's 100ms/250ms pair in
	// useTerminalSession - the re-assert recovers a resize the pane client
	// lost mid-attach).
	const webResizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
```

- [ ] **Step 4: Route mux output + reconnect re-assert**

Replace:

```tsx
			const mux = new MuxClient(config, {
				onStatus: (s) => setStatus(s),
				onTerminalData: (tid, bytes) => {
					if (tid === id) xtermRef.current?.write(bytes);
				},
```

with:

```tsx
			const mux = new MuxClient(config, {
				onStatus: (s) => {
					setStatus(s);
					// After a reconnect MuxClient re-opens the terminal but sends no
					// size; re-assert the last known grid so the fresh attach and the
					// PTY agree. Deferred one tick because onStatus fires BEFORE the
					// open frames are replayed (mux.ts ws.onopen), and the daemon
					// ignores a resize for a pane that isn't open yet. Clear the web
					// terminal so the attach repaint lands on a blank grid instead of
					// interleaving with stale cells.
					if (s === "open" && openedRef.current) {
						if (isWeb) webTermRef.current?.clear();
						const d = lastDimsRef.current;
						if (d) setTimeout(() => muxRef.current?.resize(id, d.cols, d.rows, projectId), 0);
					}
				},
				onTerminalData: (tid, bytes) => {
					if (tid !== id) return;
					if (isWeb) webTermRef.current?.write(bytes);
					else xtermRef.current?.write(bytes);
				},
```

- [ ] **Step 5: Effect cleanup + deps**

The mux effect now closes over `projectId` (the onStatus resize), and the pending web resize must die with the connection. Replace:

```tsx
		return () => {
			disposed = true;
			muxRef.current?.disconnect();
			muxRef.current = null;
		};
	}, [id]);
```

with:

```tsx
		return () => {
			disposed = true;
			if (webResizeTimer.current) {
				clearTimeout(webResizeTimer.current);
				webResizeTimer.current = null;
			}
			muxRef.current?.disconnect();
			muxRef.current = null;
		};
	}, [id, projectId]);
```

- [ ] **Step 6: Add `onWebReady` (the web attach)**

Replace:

```tsx
		muxRef.current?.openTerminal(id, projectId);
		// If the FitAddon already reported dims before open, send them to the PTY now.
		const d = lastDimsRef.current;
		if (d) muxRef.current?.resize(id, d.cols, d.rows, projectId);
	}, [id, projectId]);

	const onData = useCallback(
```

with:

```tsx
		muxRef.current?.openTerminal(id, projectId);
		// If the FitAddon already reported dims before open, send them to the PTY now.
		const d = lastDimsRef.current;
		if (d) muxRef.current?.resize(id, d.cols, d.rows, projectId);
	}, [id, projectId]);

	// Web: the DOM terminal is mounted and ready - wire its I/O to the mux and
	// attach. Mirrors onInitialized (native) plus the renderer's binding:
	// input forwards to the PTY; grid changes report a debounced resize (one
	// settled frame + one re-assert). If the socket isn't open yet, MuxClient
	// queues the open in its openTerminals map and replays it on connect; the
	// onStatus handler then re-asserts the size.
	const onWebReady = useCallback(
		(handle: WebTerminalHandle) => {
			webTermRef.current = handle;
			handle.onUserInput((data) => muxRef.current?.sendInput(id, data, projectId));
			handle.onResize(({ cols, rows }) => {
				if (webResizeTimer.current) clearTimeout(webResizeTimer.current);
				webResizeTimer.current = setTimeout(() => {
					applyDims(cols, rows);
					webResizeTimer.current = setTimeout(() => {
						webResizeTimer.current = null;
						if (openedRef.current) muxRef.current?.resize(id, cols, rows, projectId);
					}, 250);
				}, 100);
			});
			if (openedRef.current) return;
			openedRef.current = true;
			muxRef.current?.openTerminal(id, projectId);
			// The open frame carries no size; report the real grid immediately
			// (applyDims records it, updates the dims chip, and sends the resize).
			applyDims(handle.cols, handle.rows);
		},
		[id, projectId, applyDims],
	);

	const onData = useCallback(
```

- [ ] **Step 7: Make zoom web-aware**

On web the fontSize prop updates xterm in place (no remount), so open/size must NOT be reset. Replace:

```tsx
	// Zoom re-mounts the terminal at a new font size (see fontSize note above).
	// Reset open/size so the fresh mount re-attaches the PTY and re-reports dims.
	const zoom = useCallback((delta: number) => {
		setFontSize((f) => Math.min(20, Math.max(7, f + delta)));
		openedRef.current = false;
		setSize(null);
	}, []);
```

with:

```tsx
	// Zoom: native re-mounts the WebView terminal at the new font size (see the
	// key on XtermJsWebView), so open/size reset for the fresh mount to
	// re-attach. Web updates xterm's fontSize in place - the PTY stays attached
	// and the resulting onResize reports the denser grid.
	const zoom = useCallback((delta: number) => {
		setFontSize((f) => Math.min(20, Math.max(7, f + delta)));
		if (!isWeb) {
			openedRef.current = false;
			setSize(null);
		}
	}, []);
```

- [ ] **Step 8: Gate the hidden keyboard TextInput off web**

It would steal focus from xterm's own textarea. Replace:

```tsx
			<TextInput
				ref={kbInputRef}
				value=""
				onKeyPress={onKeyPress}
				onChangeText={() => {}}
				blurOnSubmit={false}
				multiline={false}
				autoCapitalize="none"
				autoCorrect={false}
				autoComplete="off"
				spellCheck={false}
				keyboardAppearance="dark"
				caretHidden
				style={styles.kbInput}
			/>
```

with:

```tsx
			{!isWeb && (
				<TextInput
					ref={kbInputRef}
					value=""
					onKeyPress={onKeyPress}
					onChangeText={() => {}}
					blurOnSubmit={false}
					multiline={false}
					autoCapitalize="none"
					autoCorrect={false}
					autoComplete="off"
					spellCheck={false}
					keyboardAppearance="dark"
					caretHidden
					style={styles.kbInput}
				/>
			)}
```

- [ ] **Step 9: Swap the phone-only panel for the real terminal**

Replace:

```tsx
				{isWeb ? (
					<View style={styles.deadOverlay}>
						<View style={styles.deadIcon}>
							<Feather name="smartphone" size={24} color={theme.textTertiary} />
						</View>
						<Text style={styles.deadTitle}>Terminal is phone-only</Text>
						<Text style={styles.deadMsg}>
							The live terminal renders in a native WebView, which the browser can't run. Open this session in
							the app on your phone to interact with it.
						</Text>
					</View>
				) : (
```

with:

```tsx
				{isWeb ? (
					<WebTerminal
						ariaLabel={`Terminal for ${id}`}
						fontSize={fontSize}
						onReady={onWebReady}
						onError={(e) => setBanner(`Terminal failed: ${e instanceof Error ? e.message : String(e)}`)}
					/>
				) : (
```

- [ ] **Step 10: Re-enable the dead/Restore overlay on web**

It is REST/store-based and works in a browser. Replace:

```tsx
				{!isWeb && dead && (
```

with:

```tsx
				{dead && (
```

- [ ] **Step 11: Hide the ⌨ toggle on web; keep the key bar right-aligned**

Replace:

```tsx
				{/* Compose a high-level message to the agent. */}
				<Pressable
					style={({ pressed }) => [styles.key, compose && styles.keyToggle, pressed && styles.keyPressed]}
					onPress={() => setCompose((c) => !c)}
				>
					<Feather name="message-square" size={15} color={compose ? theme.blue : theme.textPrimary} />
				</Pressable>
				{/* Show/hide the keyboard (replaces the OS "Done" button we removed). */}
				<Pressable
					style={({ pressed }) => [styles.key, styles.keyToggle, pressed && styles.keyPressed]}
					onPress={toggleKeyboard}
				>
					<Text style={styles.keyText}>{kbVisible ? "⌨▾" : "⌨▴"}</Text>
				</Pressable>
```

with:

```tsx
				{/* Compose a high-level message to the agent. On web it is the last
				    key (no keyboard toggle), so it carries the right-align margin. */}
				<Pressable
					style={({ pressed }) => [
						styles.key,
						isWeb && styles.keyRight,
						compose && styles.keyToggle,
						pressed && styles.keyPressed,
					]}
					onPress={() => setCompose((c) => !c)}
				>
					<Feather name="message-square" size={15} color={compose ? theme.blue : theme.textPrimary} />
				</Pressable>
				{/* Show/hide the phone keyboard - meaningless on web, where xterm
				    owns focus and a hardware keyboard types directly. */}
				{!isWeb && (
					<Pressable
						style={({ pressed }) => [styles.key, styles.keyToggle, pressed && styles.keyPressed]}
						onPress={toggleKeyboard}
					>
						<Text style={styles.keyText}>{kbVisible ? "⌨▾" : "⌨▴"}</Text>
					</Pressable>
				)}
```

And add the `keyRight` style — replace:

```tsx
	keyToggle: { borderColor: theme.accent, marginLeft: "auto" },
```

with:

```tsx
	keyToggle: { borderColor: theme.accent, marginLeft: "auto" },
	keyRight: { marginLeft: "auto" },
```

- [ ] **Step 12: Typecheck**

```bash
cd /Users/amongstar/dev/agent-orchestrator/packages/mobile
npm run typecheck
```

Expected: exit 0. If tsc flags `toggleKeyboard`/`onKeyPress`/`kbVisible` as unused, something went wrong in Step 8/11 — they must still be referenced inside the `!isWeb` JSX branches.

- [ ] **Step 13: Document the web target**

In `packages/mobile/README.md`, replace:

````markdown
```bash
cd packages/mobile
npm install
npm start          # then press i (iOS), a (Android), or scan the QR in Expo Go
```
````

with:

````markdown
```bash
cd packages/mobile
npm install
npm start          # then press i (iOS), a (Android), or scan the QR in Expo Go
npm run web        # real terminal in a desktop browser (http://localhost:8081)
```

### Web target

`npm run web` serves the same app to a desktop browser via react-native-web.
The session screen renders a real xterm.js terminal (`lib/WebTerminal.web.tsx`,
a port of the desktop renderer's terminal) against the daemon's `/mux` socket -
keyboard, paste, copy-on-select, wheel scroll (SGR reports into the pane),
zoom, and Restore all work.

- **Browser on the same machine as the daemon:** set Host `localhost`, API
  Port `3001` in Settings. Zero daemon config - the CORS guard allows
  loopback origins.
- **Browser on a different machine:** the daemon 403s non-loopback browser
  Origins. Either run the Origin-rewriting bridge (`scripts/README.md`) and
  point Settings at `<machine>:3011`, or start the daemon with
  `AO_ALLOWED_ORIGINS=http://<web-host>:8081`.
````

(The 4-backtick outer fences are this plan's formatting, not README content — the README gains the `bash` block plus the `### Web target` section.)

- [ ] **Step 14: Commit**

```bash
cd /Users/amongstar/dev/agent-orchestrator
git add "packages/mobile/app/session/[id].tsx" packages/mobile/README.md
git commit -m "feat(mobile): wire the real web terminal into the session screen"
```

---

### Task 4: Remote-access proxy — Origin/CORS rewrite (test-first)

**Files:**
- Create: `packages/mobile/scripts/ao-phone-proxy.test.js`
- Rewrite: `packages/mobile/scripts/ao-phone-proxy.js`
- Modify: `packages/mobile/scripts/README.md`

**Interfaces:**
- Consumes: nothing from other tasks (pure Node, independent of the app).
- Produces: a reverse proxy on `0.0.0.0:$PORT` → `127.0.0.1:$TARGET` with the behavior the test below pins: Origin rewritten to `http://localhost` upstream (REST + WS upgrade), `Access-Control-Allow-Origin` rewritten back to the browser's real origin on responses, preflight `OPTIONS` answered locally with 204, no-Origin requests passed through untouched, TOFU device pinning preserved.

Why the browser needs this: the daemon 403s every request whose `Origin` is neither loopback nor in `AO_ALLOWED_ORIGINS` (`backend/internal/httpd/cors.go`), browsers always send `Origin` on WS upgrades and cannot spoof it. The daemon also echoes `Access-Control-Allow-Origin` = the Origin it *received*; after the rewrite that would be `http://localhost`, which the browser rejects (ACAO must equal the page's real origin) — hence the response-side rewrite. WS upgrades need no ACAO fix: browsers don't run the CORS response check on WebSockets.

- [ ] **Step 1: Write the failing self-check**

Create `packages/mobile/scripts/ao-phone-proxy.test.js` with exactly:

```js
#!/usr/bin/env node
// Self-check for ao-phone-proxy.js: boots a mock daemon that records the
// Origin header it receives (and echoes it as ACAO, like the real CORS
// middleware), starts the proxy against it as a child process, and asserts
// the Origin/ACAO rewrites for REST, preflight, and WebSocket upgrade.
// TOFU pinning is not exercised here (everything is 127.0.0.1); it is
// unchanged first-IP-wins logic.
//
// No deps. Run:  node packages/mobile/scripts/ao-phone-proxy.test.js

const assert = require("assert");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PROXY_PORT = 34011;
const UPSTREAM_PORT = 34012;
const REAL_ORIGIN = "http://remote.example:8081";

// --- mock daemon -----------------------------------------------------------
const seen = { rest: null, upgrade: null };
const upstream = http.createServer((req, res) => {
	seen.rest = req.headers.origin ?? null;
	res.writeHead(200, {
		"content-type": "application/json",
		// Mirror the daemon: echo ACAO = the Origin it received.
		...(req.headers.origin ? { "access-control-allow-origin": req.headers.origin } : {}),
	});
	res.end(JSON.stringify({ ok: true }));
});
upstream.on("upgrade", (req, socket) => {
	seen.upgrade = req.headers.origin ?? null;
	socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
	socket.write("hello-from-upstream");
});

function request(options) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port: PROXY_PORT, agent: false, ...options }, (res) => {
			let data = "";
			res.on("data", (c) => (data += c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
		});
		req.on("error", reject);
		req.end();
	});
}

async function main() {
	await new Promise((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));

	const proxy = spawn(process.execPath, [path.join(__dirname, "ao-phone-proxy.js")], {
		env: {
			...process.env,
			PORT: String(PROXY_PORT),
			TARGET: String(UPSTREAM_PORT),
			STATE: path.join(os.tmpdir(), `ao-proxy-test-${process.pid}.json`),
			RESET: "1",
		},
		stdio: ["ignore", "pipe", "inherit"],
	});
	await new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("proxy did not start")), 5000);
		proxy.stdout.on("data", (d) => {
			if (String(d).includes("AO phone bridge")) {
				clearTimeout(t);
				resolve();
			}
		});
		proxy.on("exit", (code) => reject(new Error(`proxy exited early (${code})`)));
	});

	try {
		// 1. REST: Origin rewritten upstream; ACAO rewritten back to the real origin.
		const rest = await request({ path: "/api/sessions", headers: { origin: REAL_ORIGIN } });
		assert.strictEqual(rest.status, 200);
		assert.strictEqual(seen.rest, "http://localhost", "upstream must see a loopback Origin");
		assert.strictEqual(
			rest.headers["access-control-allow-origin"],
			REAL_ORIGIN,
			"browser must see its real origin in ACAO",
		);
		assert.ok(String(rest.headers.vary ?? "").toLowerCase().includes("origin"), "response must vary on Origin");
		assert.strictEqual(JSON.parse(rest.body).ok, true, "body must stream through");

		// 2. No-Origin request (phone fetch / curl): passed through untouched.
		seen.rest = "unset";
		const bare = await request({ path: "/healthz" });
		assert.strictEqual(bare.status, 200);
		assert.strictEqual(seen.rest, null, "proxy must not invent an Origin");

		// 3. Preflight answered at the proxy; never reaches upstream.
		seen.rest = "unset";
		const pre = await request({
			method: "OPTIONS",
			path: "/api/sessions",
			headers: {
				origin: REAL_ORIGIN,
				"access-control-request-method": "POST",
				"access-control-request-headers": "content-type",
			},
		});
		assert.strictEqual(pre.status, 204);
		assert.strictEqual(pre.headers["access-control-allow-origin"], REAL_ORIGIN);
		assert.ok(pre.headers["access-control-allow-methods"].includes("POST"));
		assert.strictEqual(pre.headers["access-control-allow-headers"], "content-type");
		assert.strictEqual(seen.rest, "unset", "preflight must not reach upstream");

		// 4. WebSocket upgrade: Origin rewritten; bytes pipe through after 101.
		await new Promise((resolve, reject) => {
			const req = http.request({
				host: "127.0.0.1",
				port: PROXY_PORT,
				path: "/mux",
				agent: false,
				headers: {
					origin: REAL_ORIGIN,
					connection: "Upgrade",
					upgrade: "websocket",
					"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
					"sec-websocket-version": "13",
				},
			});
			req.on("upgrade", (res, socket, head) => {
				try {
					assert.strictEqual(res.statusCode, 101);
					assert.strictEqual(seen.upgrade, "http://localhost", "upstream upgrade must see a loopback Origin");
					const gotData = (buf) => {
						try {
							assert.strictEqual(String(buf), "hello-from-upstream", "post-upgrade bytes must pipe through");
							socket.destroy();
							resolve();
						} catch (e) {
							reject(e);
						}
					};
					if (head && head.length) gotData(head);
					else socket.once("data", gotData);
				} catch (e) {
					reject(e);
				}
			});
			req.on("error", reject);
			req.end();
			setTimeout(() => reject(new Error("upgrade timed out")), 5000).unref();
		});

		console.log("ok - all proxy self-checks passed");
		proxy.kill();
		upstream.close();
		process.exit(0);
	} catch (e) {
		proxy.kill();
		upstream.close();
		throw e;
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
```

- [ ] **Step 2: Run it — verify it fails against the current raw-TCP proxy**

```bash
node /Users/amongstar/dev/agent-orchestrator/packages/mobile/scripts/ao-phone-proxy.test.js
```

Expected: FAIL — the current proxy is a byte pipe, so the upstream sees `Origin: http://remote.example:8081` and assertion 1 throws (`upstream must see a loopback Origin`), exit code 1. If it fails with a connection error instead, ports 34011/34012 are in use — free them and re-run.

- [ ] **Step 3: Rewrite the proxy**

Replace the entire contents of `packages/mobile/scripts/ao-phone-proxy.js` with:

```js
#!/usr/bin/env node
// LAN bridge for the AO mobile app AND the mobile-web browser build -
// trust-on-first-connect.
//
// The AO daemon stays bound to localhost (127.0.0.1:3001) - fully local and
// unexposed. This script opens ONE LAN port and forwards it to the daemon.
// The FIRST device that connects is pinned as the only allowed device; every
// other IP is refused. No discovery, no manual allowlist. (Like SSH's TOFU.)
//
// Unlike the old raw TCP pipe, this is an HTTP-aware reverse proxy, because
// a BROWSER on another machine must pass the daemon's Origin guard
// (backend/internal/httpd/cors.go): the daemon 403s any non-loopback Origin
// not in AO_ALLOWED_ORIGINS, and a browser cannot spoof its Origin. So:
//   - the incoming Origin is rewritten to http://localhost before
//     forwarding (the daemon's isLoopbackOrigin check passes it),
//   - Access-Control-Allow-Origin on responses is rewritten BACK to the
//     browser's real origin (the browser requires ACAO == the page origin;
//     the daemon echoed the rewritten one),
//   - CORS preflights (OPTIONS) are answered here and never reach the daemon,
//   - WebSocket upgrades (/mux) get the same Origin rewrite; no ACAO rewrite
//     is needed because browsers don't run the CORS response check on WS.
// Phones (React Native fetch sends no Origin; its WebSocket pins a loopback
// one) pass through unchanged, so this remains the phone bridge too.
//
// The pairing is saved, so it survives restarts. To pair a different device,
// run once with RESET=1 (or delete the state file).
//
// Usage (from the repo root, or anywhere - the path is what matters):
//   node packages/mobile/scripts/ao-phone-proxy.js         # first device pairs
//   RESET=1 node packages/mobile/scripts/ao-phone-proxy.js # forget + re-pair
//   PORT=3011 TARGET=3001 node packages/mobile/scripts/ao-phone-proxy.js
//
// Env:
//   PORT    LAN port to expose      (default 3011)
//   TARGET  loopback daemon port    (default 3001)
//   STATE   pairing file path       (default ~/.ao/phone-allow.json)
//   RESET   "1" clears the pairing before starting
//
// Self-check: node packages/mobile/scripts/ao-phone-proxy.test.js

const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = parseInt(process.env.PORT || "3011", 10);
const TARGET = parseInt(process.env.TARGET || "3001", 10);
const STATE = process.env.STATE || path.join(os.homedir(), ".ao", "phone-allow.json");

// The daemon's isLoopbackOrigin accepts this, so rewritten requests pass.
const LOOPBACK_ORIGIN = "http://localhost";

// Hop-by-hop headers describe a single connection and must not be forwarded;
// Node re-frames bodies itself (a copied Transfer-Encoding or Connection
// would corrupt the relayed message). Everything else streams through.
const HOP_BY_HOP = [
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
];

function stripHopByHop(headers) {
	for (const name of HOP_BY_HOP) delete headers[name];
	return headers;
}

// Normalize IPv4-mapped IPv6 (e.g. "::ffff:192.168.1.50") to plain IPv4.
const norm = (ip) => (ip || "").replace(/^::ffff:/, "");

if (process.env.RESET === "1") {
	try {
		fs.unlinkSync(STATE);
		console.log(`pairing reset (removed ${STATE})`);
	} catch {
		/* nothing to reset */
	}
}

let pinned = null;
try {
	pinned = JSON.parse(fs.readFileSync(STATE, "utf8")).ip || null;
} catch {
	/* not paired yet */
}

function pair(ip) {
	pinned = ip;
	try {
		fs.mkdirSync(path.dirname(STATE), { recursive: true });
		fs.writeFileSync(STATE, JSON.stringify({ ip, pairedAt: new Date().toISOString() }, null, 2));
	} catch (e) {
		console.log("warn: could not persist pairing:", e.message);
	}
	console.log(`[paired] ${ip} is now the only allowed device (RESET=1 to re-pair)`);
}

// Trust-on-first-connect, shared by the request and upgrade paths.
function allowed(ip) {
	if (!pinned) {
		pair(ip); // first device wins
		return true;
	}
	if (ip === pinned) return true;
	console.log(`[BLOCK]  ${ip} (paired device is ${pinned})`);
	return false;
}

// REST: stream the request upstream with a loopback Origin, stream the
// response back with ACAO rewritten to the browser's real origin.
const server = http.createServer((req, res) => {
	if (!allowed(norm(req.socket.remoteAddress))) {
		req.socket.destroy();
		return;
	}

	const realOrigin = req.headers.origin;

	// Answer CORS preflights here: the daemon would echo the REWRITTEN origin,
	// which the browser rejects, and upstream needs nothing from a preflight.
	if (req.method === "OPTIONS" && realOrigin && req.headers["access-control-request-method"]) {
		res.writeHead(204, {
			"Access-Control-Allow-Origin": realOrigin,
			"Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
			"Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*",
			"Access-Control-Max-Age": "600",
			Vary: "Origin",
		});
		res.end();
		return;
	}

	const headers = stripHopByHop({ ...req.headers });
	headers.host = `127.0.0.1:${TARGET}`;
	if (realOrigin) headers.origin = LOOPBACK_ORIGIN;

	const upstream = http.request(
		{ host: "127.0.0.1", port: TARGET, method: req.method, path: req.url, headers },
		(upRes) => {
			const outHeaders = stripHopByHop({ ...upRes.headers });
			if (realOrigin) {
				// The daemon echoed ACAO = the rewritten (loopback) origin; the
				// browser requires ACAO to equal the page's REAL origin.
				outHeaders["access-control-allow-origin"] = realOrigin;
				outHeaders.vary = "Origin";
			}
			res.writeHead(upRes.statusCode, outHeaders);
			upRes.pipe(res);
		},
	);
	upstream.on("error", (e) => {
		console.log(`[502] ${req.method} ${req.url}: ${e.message}`);
		if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
		res.end("upstream error");
	});
	req.pipe(upstream);
});

// WebSocket (/mux): replay the upgrade handshake with the Origin rewritten,
// then pipe raw bytes both ways. rawHeaders preserves the exact handshake
// (Connection/Upgrade/Sec-WebSocket-*); only Origin is swapped.
server.on("upgrade", (req, socket, head) => {
	if (!allowed(norm(socket.remoteAddress))) {
		socket.destroy();
		return;
	}
	const upstream = net.connect(TARGET, "127.0.0.1", () => {
		const lines = [`${req.method} ${req.url} HTTP/1.1`];
		for (let i = 0; i < req.rawHeaders.length; i += 2) {
			const name = req.rawHeaders[i];
			const value = name.toLowerCase() === "origin" ? LOOPBACK_ORIGIN : req.rawHeaders[i + 1];
			lines.push(`${name}: ${value}`);
		}
		upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
		if (head && head.length) upstream.write(head);
		socket.pipe(upstream);
		upstream.pipe(socket);
	});
	socket.on("error", () => upstream.destroy());
	upstream.on("error", () => socket.destroy());
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(
		`AO phone bridge: 0.0.0.0:${PORT} -> 127.0.0.1:${TARGET}  | ` +
			(pinned ? `paired to ${pinned}` : "waiting for first device (trust-on-first-connect)"),
	);
});
```

- [ ] **Step 4: Run the self-check — verify it passes**

```bash
node /Users/amongstar/dev/agent-orchestrator/packages/mobile/scripts/ao-phone-proxy.test.js
```

Expected output ends with:

```
ok - all proxy self-checks passed
```

Exit code 0.

- [ ] **Step 5: Update the proxy README**

In `packages/mobile/scripts/README.md`:

Replace:

```markdown
# Connecting a physical phone (LAN bridge)

The AO daemon binds to **localhost only** (`127.0.0.1:3001`) by design - it has no
auth, so it never exposes itself to the network. That means a **physical phone**
(a separate device on your Wi-Fi) can't reach it directly.

`ao-phone-proxy.js` is a tiny bridge that fixes this **without weakening the
daemon**: it opens **one** LAN port, forwards it to the loopback daemon, and uses
**trust-on-first-connect** - the first device that connects is pinned as the
_only_ allowed device; every other machine on the Wi-Fi is refused.
```

with:

```markdown
# Connecting a phone or remote browser (LAN bridge)

The AO daemon binds to **localhost only** (`127.0.0.1:3001`) by design - it has no
auth, so it never exposes itself to the network. That means a **physical phone**
or a **browser on another machine** can't reach it directly.

`ao-phone-proxy.js` is a small HTTP-aware bridge that fixes this **without
weakening the daemon**: it opens **one** LAN port, forwards REST and the `/mux`
WebSocket to the loopback daemon, and uses **trust-on-first-connect** - the
first device that connects is pinned as the _only_ allowed device; every other
machine on the Wi-Fi is refused.

For browsers it additionally rewrites the `Origin` header to `http://localhost`
on the way in (the daemon 403s non-loopback origins) and rewrites
`Access-Control-Allow-Origin` back to the browser's real origin on the way out,
answering CORS preflights itself. Phones are unaffected (React Native sends no
browser Origin). Self-check: `node packages/mobile/scripts/ao-phone-proxy.test.js`.
```

Then append at the end of the file (after the Notes section):

```markdown

## Remote browser (mobile web build)

To use the mobile app's web build (`npm run web`) from a machine that is not
running the daemon:

1. Run this bridge on the daemon machine (as above).
2. On the remote machine, open the web app and set **Settings -> Host** to the
   daemon machine's IP and **API Port** to `3011`.
3. The bridge pins the remote machine's IP as the trusted device (same TOFU
   rule as a phone - `RESET=1` to switch devices).

No-proxy alternative: start the daemon with
`AO_ALLOWED_ORIGINS=http://<web-host>:8081` and point the web app straight at
`<daemon-host>:3001`. That allowlists the browser origin at the daemon instead
of rewriting it here.
```

- [ ] **Step 6: Commit**

```bash
cd /Users/amongstar/dev/agent-orchestrator
git add packages/mobile/scripts/ao-phone-proxy.js packages/mobile/scripts/ao-phone-proxy.test.js packages/mobile/scripts/README.md
git commit -m "feat(mobile): HTTP-aware phone proxy with Origin/CORS rewrite for remote browsers"
```

---

### Task 5: End-to-end verification

**Files:** none created — this task verifies the branch against the spec's §9 checklist. Fix-forward anything that fails (smallest change, committed with a `fix(mobile):` message) and re-verify.

**Interfaces:**
- Consumes: everything from Tasks 1–4, a running AO daemon on `localhost:3001` with at least one live session (start one from the desktop app or CLI if none exists).
- Produces: a verified branch; the report back to the human lists each checklist line with pass/fail.

- [ ] **Step 1: Static gates**

```bash
cd /Users/amongstar/dev/agent-orchestrator/packages/mobile
npm run typecheck
node scripts/ao-phone-proxy.test.js
```

Expected: both exit 0.

- [ ] **Step 2: Native bundle purity (xterm must not leak into ios/android)**

```bash
cd /Users/amongstar/dev/agent-orchestrator/packages/mobile
npx expo export --platform ios --output-dir .native-export-check
grep -rl "xterm-helper-textarea" .native-export-check && echo "FAIL: xterm leaked into the native bundle" || echo "OK: native bundle clean"
rm -rf .native-export-check
```

Expected: `OK: native bundle clean`. (`xterm-helper-textarea` is a string literal inside `@xterm/xterm` that survives minification; it may only appear in a WEB bundle. The `@fressh` WebView loads its own xterm from HTML — it is not part of the Metro bundle, so a hit means the platform seam broke.) The export takes a couple of minutes.

- [ ] **Step 3: Local web run — the spec's live checklist**

Start `npm run web`, open `http://localhost:8081`, in Settings set Host `localhost` / API Port `3001`, Test connection, Save. Open a live session from the board and verify each line:

1. Status bar reads `live`; the dims chip shows the real grid (e.g. `107x33`), not a default.
2. Agent TUI output renders; box-drawing borders are crisp and aligned (WebGL renderer).
3. Typing reaches the PTY; the extra-keys bar (esc / tab / ^C / arrows / ↵) works.
4. Wheel over the terminal scrolls the pane's transcript (tmux copy-mode), NOT the agent's cursor. **Spec risk §11:** if the wheel moves the cursor, the pane is not an alt-buffer/tmux attach — STOP and report; the fallback (local `scrollback: 5000`) is a spec change, not something to apply silently.
5. Select text with the mouse → it lands on the clipboard (copy-on-select; localhost is a secure context). Cmd/Ctrl(+Shift)+V pastes; pasting multiline text does not execute line-by-line (bracketed paste).
6. Clicking an URL printed in the terminal opens a new tab.
7. Resize the browser window: the grid reflows, the dims chip updates, the TUI repaints at the new size (one resize after the drag settles, not a storm — watch the daemon log if in doubt).
8. Zoom-in/zoom-out keys change the font in place: status stays `live` (no re-attach), dims chip updates to the denser/looser grid.
9. Compose (message key) sends a prompt via REST; the globe button opens the preview iframe and its reload works — unchanged from the baseline.
10. Kill the session → dead overlay appears ("Session terminated" + Restore, now shown on web). Restore brings the terminal back live.
11. Restart the daemon: status drops to `disconnected`, then auto-reconnects to `live` and the terminal repaints at the correct size (the onStatus re-assert).

- [ ] **Step 4: Remote-origin proof via the proxy (single machine)**

A second machine is not required — a non-loopback page origin on the same machine exercises the same daemon guard:

1. Find the machine's LAN IP (`ipconfig getifaddr en0`). Open the web app as `http://<lan-ip>:8081` (Metro listens on all interfaces).
2. Negative check (no proxy): Settings → Host `localhost`, port `3001`. The mux stays `disconnected` and REST fails — DevTools network shows 403 `ORIGIN_FORBIDDEN` (the page origin `http://<lan-ip>:8081` is non-loopback).
3. Start the bridge: `RESET=1 node packages/mobile/scripts/ao-phone-proxy.js` (RESET because the test/your phone may hold the pin; note this un-pairs the phone — re-pair it afterwards if needed).
4. Positive check: Settings → Host `<lan-ip>`, port `3011`. Status goes `live`; the board loads; the terminal attaches and echoes keystrokes. In DevTools, REST responses carry `Access-Control-Allow-Origin: http://<lan-ip>:8081`.
5. Optional (spec's full scenario): repeat step 4 from a browser on a second machine; TOFU will block it until `RESET=1` re-pairs.

- [ ] **Step 5: Wrap up**

```bash
cd /Users/amongstar/dev/agent-orchestrator
git log --oneline main..mobile-web-terminal
git status
```

Expected: the Task 1–4 commits (plus any `fix(mobile):` follow-ups); a clean tree except the pre-existing `routeTree.gen.ts` churn and untracked `pnpm-lock.yaml` files. Report the checklist results; hand the branch back for review (superpowers:finishing-a-development-branch).
