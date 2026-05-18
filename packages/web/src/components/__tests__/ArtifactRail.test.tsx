import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "@aoagents/ao-core";
import { ArtifactRail } from "../ArtifactRail";

function mockArtifactsFetch(artifacts: Artifact[]) {
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ artifacts }),
    } as Response),
  ) as unknown as typeof fetch;
}

function mockArtifactsFetchError(message: string) {
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: false,
      status: 500,
      statusText: message,
      json: () => Promise.resolve({}),
    } as Response),
  ) as unknown as typeof fetch;
}

const SESSION_ID = "sess-1";

const markdownArtifact: Artifact = {
  version: 1,
  type: "markdown",
  id: "md-1",
  title: "Notes",
  createdAt: "2026-05-13T00:00:00.000Z",
  updatedAt: "2026-05-13T00:00:00.000Z",
  source: "agent",
  payload: { markdown: "# Hello" },
};

const htmlArtifact: Artifact = {
  version: 1,
  type: "html",
  id: "html-1",
  title: "Chart",
  createdAt: "2026-05-13T00:00:00.000Z",
  updatedAt: "2026-05-13T00:00:00.000Z",
  source: "agent",
  payload: { html: "<p>chart</p>" },
};

describe("ArtifactRail", () => {
  beforeEach(() => {
    // Default — empty list. Per-test overrides as needed.
    mockArtifactsFetch([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a loading state initially", () => {
    // Use a never-resolving fetch to keep the rail in loading state.
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<ArtifactRail sessionId={SESSION_ID} />);
    expect(screen.getByText("Loading artifacts…")).toBeInTheDocument();
  });

  it("renders an empty state when no artifacts", async () => {
    mockArtifactsFetch([]);
    render(<ArtifactRail sessionId={SESSION_ID} />);
    await waitFor(() => expect(screen.getByText("No artifacts yet.")).toBeInTheDocument());
  });

  it("renders an error state when fetch fails", async () => {
    mockArtifactsFetchError("boom");
    render(<ArtifactRail sessionId={SESSION_ID} />);
    await waitFor(() => expect(screen.getByText(/Failed to load artifacts/)).toBeInTheDocument());
  });

  it("dispatches to ArtifactMarkdown for markdown artifacts", async () => {
    mockArtifactsFetch([markdownArtifact]);
    const { container } = render(<ArtifactRail sessionId={SESSION_ID} />);
    await waitFor(() =>
      expect(container.querySelector('[data-artifact-type="markdown"]')).not.toBeNull(),
    );
    // Markdown is parsed — # Hello should render as h1.
    expect(container.querySelector('[data-artifact-type="markdown"] h1')?.textContent).toBe("Hello");
  });

  it("dispatches to ArtifactHtml for html artifacts", async () => {
    mockArtifactsFetch([htmlArtifact]);
    const { container } = render(<ArtifactRail sessionId={SESSION_ID} />);
    await waitFor(() =>
      expect(container.querySelector('[data-artifact-type="html"]')).not.toBeNull(),
    );
    const iframe = container.querySelector('[data-artifact-type="html"] iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("renders cards in updatedAt desc order (newest first)", async () => {
    const older: Artifact = {
      ...markdownArtifact,
      id: "older",
      title: "Older",
      updatedAt: "2026-05-12T00:00:00.000Z",
      payload: { markdown: "older body" },
    };
    const newer: Artifact = {
      ...markdownArtifact,
      id: "newer",
      title: "Newer",
      updatedAt: "2026-05-14T00:00:00.000Z",
      payload: { markdown: "newer body" },
    };
    // Intentionally give them in wrong order — the rail must sort.
    mockArtifactsFetch([older, newer]);

    const { container } = render(<ArtifactRail sessionId={SESSION_ID} />);
    await waitFor(() =>
      expect(container.querySelectorAll(".artifact-card-title").length).toBe(2),
    );

    const titles = Array.from(container.querySelectorAll(".artifact-card-title")).map(
      (n) => n.textContent,
    );
    expect(titles).toEqual(["Newer", "Older"]);
  });

  it("renders the rail header with count when artifacts exist", async () => {
    mockArtifactsFetch([markdownArtifact, htmlArtifact]);
    const { container } = render(<ArtifactRail sessionId={SESSION_ID} />);
    await waitFor(() =>
      expect(container.querySelectorAll(".artifact-card-title").length).toBe(2),
    );
    expect(screen.getByRole("heading", { name: "Artifacts" })).toBeInTheDocument();
    expect(container.querySelector(".artifact-rail-count")?.textContent).toBe("2");
  });
});
