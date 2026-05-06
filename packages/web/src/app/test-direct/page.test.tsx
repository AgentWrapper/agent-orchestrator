import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

const MockDirectTerminal = ({
  sessionId,
  startFullscreen,
}: {
  sessionId: string;
  startFullscreen: boolean;
}) => (
  <div data-testid="direct-terminal">
    {sessionId}:{String(startFullscreen)}
  </div>
);

vi.mock("@/components/DirectTerminal", () => ({
  DirectTerminal: MockDirectTerminal,
}));

// next/dynamic wraps lazy imports; in tests, bypass the dynamic loader and
// return the mock component directly.
vi.mock("next/dynamic", () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (_loader: any) => MockDirectTerminal,
}));

describe("TestDirectPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the default direct terminal clipboard instructions", async () => {
    searchParams = new URLSearchParams();
    const { default: TestDirectPage } = await import("./page");

    render(<TestDirectPage />);

    expect(screen.getByText("DirectTerminal Test - XDA Clipboard Support")).toBeInTheDocument();
    expect(screen.getByText("Testing:")).toBeInTheDocument();
    expect(screen.getByText("ao-orchestrator")).toBeInTheDocument();
    expect(screen.getByTestId("direct-terminal")).toHaveTextContent("ao-orchestrator:false");
  });

  it("passes session and fullscreen params to the terminal", async () => {
    searchParams = new URLSearchParams("session=ao-20&fullscreen=true");
    const { default: TestDirectPage } = await import("./page");

    render(<TestDirectPage />);

    expect(screen.getByTestId("direct-terminal")).toHaveTextContent("ao-20:true");
    expect(screen.getByText(/clipboard works without iTerm2 attachment/i)).toBeInTheDocument();
  });
});
