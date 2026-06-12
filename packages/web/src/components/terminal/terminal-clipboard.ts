import type { Terminal as TerminalType } from "@xterm/xterm";

/**
 * Write text to the system clipboard with layered fallback:
 * 1. navigator.clipboard.writeText — requires a secure context (https or
 *    localhost) and clipboard-write permission.
 * 2. document.execCommand("copy") via a temporary textarea — works on
 *    non-secure origins (e.g. dashboard opened via LAN IP).
 *
 * Resolves true when either path succeeds, false when both fail — callers
 * surface the result to the user instead of silently swallowing it.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or transient failure — fall through to execCommand.
    }
  }
  return execCommandCopy(text);
}

function execCommandCopy(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  // Visually hidden without inline styles; sr-only keeps the textarea
  // selectable so execCommand("copy") still picks up its content.
  textarea.className = "sr-only";
  const previouslyFocused = document.activeElement;
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    // The textarea stole focus from the terminal — give it back.
    if (previouslyFocused instanceof HTMLElement) {
      previouslyFocused.focus();
    }
  }
}

/**
 * Wire tmux-compatible clipboard integration into an xterm.js instance:
 * - Responds to XDA (CSI > q) with an "XTerm(" identity so tmux enables
 *   TTYC_MS and starts sending OSC 52 for copy.
 * - Decodes OSC 52 base64 payloads and writes them to the clipboard.
 * - Intercepts Cmd+C / Ctrl+Shift+C to copy the current xterm selection
 *   (paste is handled natively by xterm's internal textarea).
 *
 * Every copy attempt reports its outcome through `onCopyResult` so the UI
 * can show feedback (clipboard access fails silently on non-secure origins
 * otherwise).
 */
export function registerClipboardHandlers(
  terminal: TerminalType,
  onCopyResult?: (ok: boolean) => void,
): void {
  const copy = (text: string) => {
    void writeClipboardText(text).then((ok) => onCopyResult?.(ok));
  };

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
      copy(text);
    } catch {
      // Decode failed — the user's copy-mode copy produced nothing.
      onCopyResult?.(false);
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
      copy(terminal.getSelection());
      terminal.clearSelection();
      return false;
    }

    return true;
  });
}
