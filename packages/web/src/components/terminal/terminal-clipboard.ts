import type { Terminal as TerminalType } from "@xterm/xterm";

/**
 * Wire tmux-compatible clipboard integration into an xterm.js instance:
 * - Responds to XDA (CSI > q) with an "XTerm(" identity so tmux enables
 *   TTYC_MS and starts sending OSC 52 for copy.
 * - Decodes OSC 52 base64 payloads and writes them to navigator.clipboard.
 * - Intercepts Cmd+C / Ctrl+Shift+C to copy the current xterm selection
 *   (paste is handled natively by xterm's internal textarea).
 */
export function registerClipboardHandlers(terminal: TerminalType): void {
  // **CRITICAL FIX**: Register XDA (Extended Device Attributes) handler.
  // tmux looks for "XTerm(" in the response (see tmux tty-keys.c) and
  // enables TTYC_MS (clipboard / OSC 52) when it sees it.
  terminal.parser.registerCsiHandler(
    { prefix: ">", final: "q" }, // CSI > q is XTVERSION / XDA
    () => {
      terminal.write("\x1bP>|XTerm(370)\x1b\\");
      return true;
    },
  );

  // OSC 52 — tmux sends base64-encoded text when copying.
  terminal.parser.registerOscHandler(52, (data) => {
    const parts = data.split(";");
    if (parts.length < 2) return false;
    const b64 = parts[parts.length - 1];
    try {
      // Decode base64 → binary string → Uint8Array → UTF-8 text.
      // atob() alone only handles Latin-1; TextDecoder is needed for UTF-8.
      const binary = atob(b64);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      navigator.clipboard?.writeText(text).catch(() => {});
    } catch {
      // Ignore decode errors
    }
    return true;
  });

  // Cmd+C (Mac) / Ctrl+Shift+C (Linux/Win) — copy selection.
  // Paste is handled natively by xterm.js via its textarea.
  terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== "keydown") return true;

    const isCopy =
      (e.metaKey && !e.ctrlKey && !e.altKey && e.code === "KeyC") ||
      (e.ctrlKey && e.shiftKey && e.code === "KeyC");
    if (isCopy && terminal.hasSelection()) {
      navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {});
      terminal.clearSelection();
      return false;
    }

    return true;
  });
}
