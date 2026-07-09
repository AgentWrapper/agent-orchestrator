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
