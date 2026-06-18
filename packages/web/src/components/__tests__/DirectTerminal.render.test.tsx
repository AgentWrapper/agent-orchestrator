import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectTerminal } from "../DirectTerminal";

const replaceMock = vi.fn();
let searchParams = new URLSearchParams();
const { useFullscreenResizeMock } = vi.hoisted(() => ({
  useFullscreenResizeMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/test-direct",
  useSearchParams: () => searchParams,
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

vi.mock("../terminal/useFullscreenResize", () => ({
  useFullscreenResize: useFullscreenResizeMock,
}));

class MockTerminal {
  static loadedAddons: unknown[] = [];
  static lastOptions: Record<string, unknown> | null = null;
  options: Record<string, unknown>;
  parser = {
    registerCsiHandler: vi.fn(),
    registerOscHandler: vi.fn(),
  };
  cols = 80;
  rows = 24;
  unicode = { activeVersion: "" };

  constructor(options: Record<string, unknown>) {
    this.options = options;
    MockTerminal.lastOptions = options;
  }

  loadAddon(addon: unknown) {
    MockTerminal.loadedAddons.push(addon);
  }
  open() {}
  write() {}
  refresh() {}
  dispose() {}
  hasSelection() {
    return false;
  }
  getSelection() {
    return "";
  }
  clearSelection() {}
  onSelectionChange() {
    return { dispose() {} };
  }
  attachCustomKeyEventHandler() {}
  onData() {
    return { dispose() {} };
  }
}

class MockFitAddon {
  fit() {}
}

function MockWebLinksAddon() {
  return undefined;
}

class MockWebglAddon {
  onContextLoss() {}
  dispose() {}
}

class MockUnicode11Addon {
  dispose() {}
}

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.OPEN;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }

  send() {}
  close() {}
}

vi.mock("@xterm/xterm", () => ({
  Terminal: MockTerminal,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: MockFitAddon,
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: MockWebLinksAddon,
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: MockWebglAddon,
}));

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: MockUnicode11Addon,
}));

vi.mock("@/hooks/useMux", () => ({
  useMux: () => ({
    subscribeTerminal: vi.fn(() => vi.fn()),
    writeTerminal: vi.fn(),
    openTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    resizeTerminal: vi.fn(),
    status: "connected",
    sessions: [],
    terminals: [],
  }),
}));

describe("DirectTerminal render", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams();
    MockTerminal.loadedAddons = [];
    MockTerminal.lastOptions = null;
    replaceMock.mockReset();
    useFullscreenResizeMock.mockReset();
    MockWebSocket.instances = [];
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        ready: Promise.resolve(),
        // FontFaceSet is an EventTarget in real browsers; the component
        // listens for 'loadingdone' to re-fit after webfont swap. Stub the
        // methods so init doesn't throw.
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          proxyWsPath: "/ao-terminal-ws",
        }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the shared accent chrome for orchestrator terminals", async () => {
    render(
      <DirectTerminal
        sessionId="ao-orchestrator"
        tmuxName="ao-orchestrator"
        variant="orchestrator"
      />,
    );

    // The mockup term-head shows no connection-status text — the mono session
    // id is the chrome's identity marker now.
    await waitFor(() => expect(screen.getByText("ao-orchestrator")).toBeInTheDocument());

    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByText("XDA")).toBeNull();
  });

  it("keeps restart and fullscreen actions available in chromeless mode", async () => {
    render(
      <DirectTerminal
        sessionId="ao-opencode"
        tmuxName="ao-opencode"
        chromeless
        isOpenCodeSession
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Restart OpenCode session" })).toBeInTheDocument(),
    );

    expect(screen.getByRole("button", { name: "fullscreen" })).toBeInTheDocument();
    expect(screen.queryByText("XDA")).toBeNull();
  });

  it("switches the terminal shell between inline and fullscreen positioning", async () => {
    const { container } = render(
      <DirectTerminal
        sessionId="ao-orchestrator"
        tmuxName="ao-orchestrator"
        variant="orchestrator"
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "fullscreen" })).toBeInTheDocument(),
    );

    const terminalShell = container.firstElementChild;
    expect(terminalShell).not.toBeNull();
    expect(terminalShell).toHaveClass("relative");
    expect(terminalShell).not.toHaveClass("fixed");

    fireEvent.click(screen.getByRole("button", { name: "fullscreen" }));

    expect(screen.getByRole("button", { name: "exit fullscreen" })).toBeInTheDocument();
    expect(terminalShell).toHaveClass("fixed", "inset-0");
    expect(terminalShell).not.toHaveClass("relative");

    fireEvent.click(screen.getByRole("button", { name: "exit fullscreen" }));

    expect(screen.getByRole("button", { name: "fullscreen" })).toBeInTheDocument();
    expect(terminalShell).toHaveClass("relative");
    expect(terminalShell).not.toHaveClass("fixed");
  });

  it("enforces a dark-mode contrast floor so low-contrast agent output stays legible", async () => {
    render(
      <DirectTerminal
        sessionId="ao-orchestrator"
        tmuxName="ao-orchestrator"
        variant="orchestrator"
      />,
    );

    // useTheme is mocked to "dark"; the terminal must enforce a contrast floor > 1
    // so ANSI white-on-white blocks (Claude Code's expanded command) stay readable.
    await waitFor(() => expect(MockTerminal.lastOptions).not.toBeNull());
    expect(MockTerminal.lastOptions?.minimumContrastRatio).toBe(4.5);
    // out-of-font glyphs (arrows, CJK, emoji) must be rescaled to their cell so
    // a wide fallback glyph can't overlap the following character
    expect(MockTerminal.lastOptions?.rescaleOverlappingGlyphs).toBe(true);
  });

  it("loads the Unicode 11 addon so emoji widths match modern terminals", async () => {
    render(
      <DirectTerminal
        sessionId="ao-orchestrator"
        tmuxName="ao-orchestrator"
        variant="orchestrator"
      />,
    );

    await waitFor(() =>
      expect(MockTerminal.loadedAddons.some((addon) => addon instanceof MockUnicode11Addon)).toBe(
        true,
      ),
    );
  });

  it("loads the WebGL renderer addon for crisp box-drawing", async () => {
    render(
      <DirectTerminal
        sessionId="ao-orchestrator"
        tmuxName="ao-orchestrator"
        variant="orchestrator"
      />,
    );

    // The addon is loaded rAF-deferred after open(), so wait for it to attach.
    await waitFor(() =>
      expect(MockTerminal.loadedAddons.some((addon) => addon instanceof MockWebglAddon)).toBe(true),
    );
  });

  it("passes projectId to fullscreen resize hook for scoped mux resize", () => {
    render(<DirectTerminal sessionId="app-1" projectId="project-a" tmuxName="project-a-app-1" />);

    expect(useFullscreenResizeMock).toHaveBeenCalledWith(
      false,
      "app-1",
      "project-a",
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
    );
  });
});
