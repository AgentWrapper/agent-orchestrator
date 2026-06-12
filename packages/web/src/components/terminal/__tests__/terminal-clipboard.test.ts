import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal as TerminalType } from "@xterm/xterm";
import { registerClipboardHandlers, writeClipboardText } from "../terminal-clipboard";

type CsiHandler = () => boolean | Promise<boolean>;
type OscHandler = (data: string) => boolean | Promise<boolean>;
type KeyHandler = (event: KeyboardEvent) => boolean;

interface Captured {
  csi: { id: { prefix?: string; final: string }; handler: CsiHandler } | null;
  osc: { ident: number; handler: OscHandler } | null;
  key: KeyHandler | null;
}

function makeMockTerminal(selection = "") {
  const captured: Captured = { csi: null, osc: null, key: null };
  const writes: string[] = [];
  const hasSelection = vi.fn(() => selection.length > 0);
  const getSelection = vi.fn(() => selection);
  const clearSelection = vi.fn();

  const terminal = {
    parser: {
      registerCsiHandler: (id: Captured["csi"]["id"], handler: CsiHandler) => {
        captured.csi = { id, handler };
        return { dispose() {} };
      },
      registerOscHandler: (ident: number, handler: OscHandler) => {
        captured.osc = { ident, handler };
        return { dispose() {} };
      },
    },
    write: (data: string) => {
      writes.push(data);
    },
    attachCustomKeyEventHandler: (handler: KeyHandler) => {
      captured.key = handler;
    },
    hasSelection,
    getSelection,
    clearSelection,
  } as unknown as TerminalType;

  return { terminal, captured, writes, hasSelection, getSelection, clearSelection };
}

function encodeOsc52(text: string, target = "c"): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `${target};${btoa(binary)}`;
}

/** Let pending clipboard promises (writeText → .then chains) settle. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** jsdom has no execCommand — define a configurable mock for fallback tests. */
function defineExecCommand(impl: () => boolean) {
  const mock = vi.fn(impl);
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: mock,
  });
  return mock;
}

/** Simulate a non-secure origin where navigator.clipboard is undefined. */
function removeClipboardApi() {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  });
}

describe("registerClipboardHandlers", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText } },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "execCommand");
    vi.restoreAllMocks();
  });

  describe("XDA (CSI > q) handler", () => {
    it("registers with prefix '>' and final 'q'", () => {
      const { terminal, captured } = makeMockTerminal();
      registerClipboardHandlers(terminal);
      expect(captured.csi?.id).toEqual({ prefix: ">", final: "q" });
    });

    it("responds with XTerm(...) identity that tmux recognises", () => {
      const { terminal, captured, writes } = makeMockTerminal();
      registerClipboardHandlers(terminal);

      const handled = captured.csi!.handler();

      expect(handled).toBe(true);
      expect(writes).toHaveLength(1);
      // tmux looks for "XTerm(" in the response — see tmux tty-keys.c.
      expect(writes[0]).toContain("XTerm(");
      // Response is wrapped in DCS (ESC P) ... ST (ESC \).
      expect(writes[0].startsWith("\x1bP")).toBe(true);
      expect(writes[0].endsWith("\x1b\\")).toBe(true);
    });
  });

  describe("OSC 52 decoder", () => {
    it("registers on OSC identifier 52", () => {
      const { terminal, captured } = makeMockTerminal();
      registerClipboardHandlers(terminal);
      expect(captured.osc?.ident).toBe(52);
    });

    it("decodes base64 ASCII and writes to clipboard", async () => {
      const { terminal, captured } = makeMockTerminal();
      registerClipboardHandlers(terminal);

      const handled = await captured.osc!.handler(encodeOsc52("hello world"));

      expect(handled).toBe(true);
      expect(writeText).toHaveBeenCalledWith("hello world");
    });

    it("decodes UTF-8 multi-byte sequences correctly", async () => {
      const { terminal, captured } = makeMockTerminal();
      registerClipboardHandlers(terminal);

      // Emoji + CJK — these break if we naively String.fromCharCode the bytes.
      await captured.osc!.handler(encodeOsc52("漢字 🚀"));

      expect(writeText).toHaveBeenCalledWith("漢字 🚀");
    });

    it("returns false when payload has no semicolon separator", async () => {
      const { terminal, captured } = makeMockTerminal();
      registerClipboardHandlers(terminal);

      const handled = await captured.osc!.handler("malformed");

      expect(handled).toBe(false);
      expect(writeText).not.toHaveBeenCalled();
    });

    it("swallows decode errors without throwing", async () => {
      const { terminal, captured } = makeMockTerminal();
      registerClipboardHandlers(terminal);

      // atob() throws on invalid base64.
      const handled = await captured.osc!.handler("c;not_valid_base64!!!");

      expect(handled).toBe(true);
      expect(writeText).not.toHaveBeenCalled();
    });

    it("does not throw on clipboard write rejection", async () => {
      writeText.mockReturnValue(Promise.reject(new Error("denied")));
      const { terminal, captured } = makeMockTerminal();
      registerClipboardHandlers(terminal);

      // The handler attaches a .catch() to the clipboard write so rejections
      // don't escape as unhandled. Returns sync true regardless.
      expect(() => captured.osc!.handler(encodeOsc52("x"))).not.toThrow();
      // Let the rejected promise's .catch() handler run.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  describe("Cmd+C / Ctrl+Shift+C copy handler", () => {
    function keyEvent(init: Partial<KeyboardEvent>): KeyboardEvent {
      return {
        type: "keydown",
        code: "KeyC",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        ...init,
      } as KeyboardEvent;
    }

    it("copies selection and returns false on Cmd+C (Mac)", () => {
      const { terminal, captured, getSelection, clearSelection } =
        makeMockTerminal("selected text");
      registerClipboardHandlers(terminal);

      const result = captured.key!(keyEvent({ metaKey: true }));

      expect(result).toBe(false);
      expect(getSelection).toHaveBeenCalled();
      expect(writeText).toHaveBeenCalledWith("selected text");
      expect(clearSelection).toHaveBeenCalled();
    });

    it("copies selection on Ctrl+Shift+C (Linux/Windows)", () => {
      const { terminal, captured, clearSelection } = makeMockTerminal("linux text");
      registerClipboardHandlers(terminal);

      const result = captured.key!(keyEvent({ ctrlKey: true, shiftKey: true }));

      expect(result).toBe(false);
      expect(writeText).toHaveBeenCalledWith("linux text");
      expect(clearSelection).toHaveBeenCalled();
    });

    it("does nothing when there is no selection", () => {
      const { terminal, captured, clearSelection } = makeMockTerminal("");
      registerClipboardHandlers(terminal);

      const result = captured.key!(keyEvent({ metaKey: true }));

      expect(result).toBe(true);
      expect(writeText).not.toHaveBeenCalled();
      expect(clearSelection).not.toHaveBeenCalled();
    });

    it("ignores Ctrl+C without shift (that's SIGINT, must pass through)", () => {
      const { terminal, captured, clearSelection } = makeMockTerminal("anything");
      registerClipboardHandlers(terminal);

      const result = captured.key!(keyEvent({ ctrlKey: true }));

      expect(result).toBe(true);
      expect(writeText).not.toHaveBeenCalled();
      expect(clearSelection).not.toHaveBeenCalled();
    });

    it("ignores Cmd+Ctrl+C combos (alt modifier leaves plain Cmd+C uncontaminated)", () => {
      const { terminal, captured } = makeMockTerminal("text");
      registerClipboardHandlers(terminal);

      const result = captured.key!(keyEvent({ metaKey: true, ctrlKey: true }));

      expect(result).toBe(true);
      expect(writeText).not.toHaveBeenCalled();
    });

    it("passes through keyup events untouched", () => {
      const { terminal, captured } = makeMockTerminal("text");
      registerClipboardHandlers(terminal);

      const result = captured.key!(keyEvent({ type: "keyup", metaKey: true }));

      expect(result).toBe(true);
      expect(writeText).not.toHaveBeenCalled();
    });
  });

  describe("onCopyResult feedback", () => {
    it("reports success after an OSC 52 copy", async () => {
      const onCopyResult = vi.fn();
      const { terminal, captured } = makeMockTerminal();
      registerClipboardHandlers(terminal, onCopyResult);

      await captured.osc!.handler(encodeOsc52("hello"));
      await flushPromises();

      expect(onCopyResult).toHaveBeenCalledWith(true);
    });

    it("reports failure when clipboard rejects and execCommand is unavailable", async () => {
      writeText.mockReturnValue(Promise.reject(new Error("denied")));
      const onCopyResult = vi.fn();
      const { terminal, captured } = makeMockTerminal();
      registerClipboardHandlers(terminal, onCopyResult);

      await captured.osc!.handler(encodeOsc52("hello"));
      await flushPromises();

      expect(onCopyResult).toHaveBeenCalledWith(false);
    });

    it("reports success when clipboard rejects but the execCommand fallback works", async () => {
      writeText.mockReturnValue(Promise.reject(new Error("denied")));
      defineExecCommand(() => true);
      const onCopyResult = vi.fn();
      const { terminal, captured } = makeMockTerminal();
      registerClipboardHandlers(terminal, onCopyResult);

      await captured.osc!.handler(encodeOsc52("hello"));
      await flushPromises();

      expect(onCopyResult).toHaveBeenCalledWith(true);
    });

    it("reports failure when the OSC 52 payload cannot be decoded", async () => {
      const onCopyResult = vi.fn();
      const { terminal, captured } = makeMockTerminal();
      registerClipboardHandlers(terminal, onCopyResult);

      await captured.osc!.handler("c;not_valid_base64!!!");

      expect(onCopyResult).toHaveBeenCalledWith(false);
    });

    it("reports the outcome of a Cmd+C copy", async () => {
      const onCopyResult = vi.fn();
      const { terminal, captured } = makeMockTerminal("selected text");
      registerClipboardHandlers(terminal, onCopyResult);

      captured.key!({
        type: "keydown",
        code: "KeyC",
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      } as KeyboardEvent);
      await flushPromises();

      expect(onCopyResult).toHaveBeenCalledWith(true);
    });
  });
});

describe("writeClipboardText", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText } },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "execCommand");
    vi.restoreAllMocks();
  });

  it("resolves true via navigator.clipboard on secure origins", async () => {
    await expect(writeClipboardText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when navigator.clipboard is undefined (non-secure origin)", async () => {
    removeClipboardApi();
    let copiedValue = "";
    const exec = defineExecCommand(() => {
      copiedValue = document.querySelector("textarea")?.value ?? "";
      return true;
    });

    await expect(writeClipboardText("lan copy")).resolves.toBe(true);

    expect(exec).toHaveBeenCalledWith("copy");
    expect(copiedValue).toBe("lan copy");
  });

  it("falls back to execCommand when writeText is permission-denied", async () => {
    writeText.mockReturnValue(Promise.reject(new Error("NotAllowedError")));
    const exec = defineExecCommand(() => true);

    await expect(writeClipboardText("denied")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("resolves false when clipboard is missing and execCommand is unavailable", async () => {
    removeClipboardApi();
    // jsdom has no document.execCommand by default — both layers fail.
    await expect(writeClipboardText("nope")).resolves.toBe(false);
  });

  it("resolves false when execCommand reports failure", async () => {
    removeClipboardApi();
    defineExecCommand(() => false);

    await expect(writeClipboardText("nope")).resolves.toBe(false);
  });

  it("resolves false when execCommand throws", async () => {
    removeClipboardApi();
    defineExecCommand(() => {
      throw new Error("blocked");
    });

    await expect(writeClipboardText("nope")).resolves.toBe(false);
  });

  it("removes the temporary textarea after the fallback runs", async () => {
    removeClipboardApi();
    defineExecCommand(() => true);

    await writeClipboardText("cleanup");

    expect(document.querySelector("textarea")).toBeNull();
  });
});
