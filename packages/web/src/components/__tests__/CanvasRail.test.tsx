import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CanvasArtifact } from "@aoagents/ao-core";
import { CanvasRail } from "../CanvasRail";

const markdownCanvas: CanvasArtifact = {
  version: 1,
  id: "notes",
  type: "markdown",
  title: "Notes",
  createdAt: "2026-05-05T00:00:00Z",
  updatedAt: "2026-05-05T00:00:00Z",
  payload: { markdown: "Hello canvas" },
};

const statsCanvas: CanvasArtifact = {
  version: 1,
  id: "stats",
  type: "stats",
  title: "Run stats",
  createdAt: "2026-05-05T00:00:00Z",
  updatedAt: "2026-05-05T00:01:00Z",
  payload: { metrics: [{ label: "Pass", value: 7, tone: "good" }] },
};

function mockFetch(canvases: CanvasArtifact[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ canvases }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CanvasRail", () => {
  it("starts collapsed when no canvases exist", async () => {
    vi.stubGlobal("fetch", mockFetch([]));
    render(<CanvasRail sessionId="ao-1" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Open canvas rail")).toBeInTheDocument();
    expect(screen.queryByText("Notes")).not.toBeInTheDocument();
  });

  it("auto-expands and renders title when canvases arrive", async () => {
    vi.stubGlobal("fetch", mockFetch([markdownCanvas]));
    render(<CanvasRail sessionId="ao-1" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.getByText("Hello canvas")).toBeInTheDocument();
  });

  it("dispatches to the stats renderer for stats canvases", async () => {
    vi.stubGlobal("fetch", mockFetch([statsCanvas]));
    render(<CanvasRail sessionId="ao-1" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Run stats")).toBeInTheDocument();
    expect(screen.getByText("Pass")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });
});
