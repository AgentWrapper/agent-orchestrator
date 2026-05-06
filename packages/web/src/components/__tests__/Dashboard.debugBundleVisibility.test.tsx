import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../Dashboard";

let search = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(search),
}));

function mockDesktopViewport() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: !query.includes("max-width: 767px"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe("Dashboard debug bundle visibility", () => {
  beforeEach(() => {
    search = "";
    mockDesktopViewport();
    const eventSourceMock = {
      onmessage: null,
      onerror: null,
      close: vi.fn(),
    };
    const eventSourceConstructor = vi.fn(() => eventSourceMock as unknown as EventSource);
    global.EventSource = Object.assign(eventSourceConstructor, {
      CONNECTING: 0,
      OPEN: 1,
      CLOSED: 2,
    }) as unknown as typeof EventSource;
    global.fetch = vi.fn();
  });

  it("hides debug bundle button by default", () => {
    render(<Dashboard initialSessions={[]} />);
    expect(screen.queryByRole("button", { name: /Copy debug bundle for issue reports/i })).toBeNull();
  });

  it("shows debug bundle button when debug query flag is enabled", () => {
    search = "debug=1";
    render(<Dashboard initialSessions={[]} />);
    expect(screen.getByRole("button", { name: /Copy debug bundle for issue reports/i })).toBeInTheDocument();
  });
});
