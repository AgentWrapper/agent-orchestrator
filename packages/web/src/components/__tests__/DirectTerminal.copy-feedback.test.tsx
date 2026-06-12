import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectTerminal } from "../DirectTerminal";

const replaceMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/test-direct",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

vi.mock("../terminal/useFullscreenResize", () => ({
  useFullscreenResize: vi.fn(),
}));

// Capture the options DirectTerminal passes into the terminal hook so tests
// can drive onCopyResult, and control the mouseReporting flag it returns.
const hookState = vi.hoisted(() => ({
  options: null as { onCopyResult?: (ok: boolean) => void } | null,
  mouseReporting: false,
}));

vi.mock("../terminal/useXtermTerminal", () => ({
  useXtermTerminal: (
    _ref: unknown,
    _sessionId: string,
    options: { onCopyResult?: (ok: boolean) => void },
  ) => {
    hookState.options = options;
    return {
      error: null,
      followOutput: true,
      scrollToLatest: vi.fn(),
      muxStatus: "connected" as const,
      terminalInstance: { current: null },
      fitAddon: { current: null },
      mouseReporting: hookState.mouseReporting,
    };
  },
}));

describe("DirectTerminal copy feedback", () => {
  beforeEach(() => {
    hookState.options = null;
    hookState.mouseReporting = false;
    replaceMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows a transient 'Copied' pill on successful copy and dismisses it", () => {
    render(<DirectTerminal sessionId="s-1" tmuxName="s-1" />);

    act(() => {
      hookState.options!.onCopyResult!(true);
    });

    expect(screen.getByRole("status")).toHaveTextContent("Copied");

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows 'Copy failed' when the clipboard write fails", () => {
    render(<DirectTerminal sessionId="s-1" tmuxName="s-1" />);

    act(() => {
      hookState.options!.onCopyResult!(false);
    });

    expect(screen.getByRole("status")).toHaveTextContent("Copy failed");
  });

  it("resets the dismiss timer when copies happen back to back", () => {
    render(<DirectTerminal sessionId="s-1" tmuxName="s-1" />);

    act(() => {
      hookState.options!.onCopyResult!(true);
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    act(() => {
      hookState.options!.onCopyResult!(true);
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    // 1.5s after the second copy — still within its own 2s window.
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
  });

  it("shows the shift-drag selection hint while mouse reporting is active", () => {
    hookState.mouseReporting = true;
    render(<DirectTerminal sessionId="s-1" tmuxName="s-1" />);

    expect(screen.getByText("⇧+drag to select")).toBeInTheDocument();
  });

  it("shows the selection hint in chromeless mode too", () => {
    hookState.mouseReporting = true;
    render(<DirectTerminal sessionId="s-1" tmuxName="s-1" chromeless />);

    expect(screen.getByText("⇧+drag to select")).toBeInTheDocument();
  });

  it("hides the selection hint when mouse reporting is inactive", () => {
    render(<DirectTerminal sessionId="s-1" tmuxName="s-1" />);

    expect(screen.queryByText("⇧+drag to select")).toBeNull();
  });
});
