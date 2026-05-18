import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Artifact } from "@aoagents/ao-core";
import { ArtifactHtml } from "../ArtifactHtml";

function htmlArtifact(html: string, overrides: Partial<Artifact> = {}): Extract<
  Artifact,
  { type: "html" }
> {
  return {
    version: 1,
    type: "html",
    id: "test",
    title: "Test HTML",
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
    source: "agent",
    ...overrides,
    payload: { html },
  } as Extract<Artifact, { type: "html" }>;
}

describe("ArtifactHtml", () => {
  it("renders the HTML inside an iframe element", () => {
    const { container } = render(<ArtifactHtml artifact={htmlArtifact("<p>hello</p>")} />);
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
  });

  it("uses sandbox='allow-scripts' WITHOUT allow-same-origin", () => {
    const { container } = render(<ArtifactHtml artifact={htmlArtifact("<p>hi</p>")} />);
    const iframe = container.querySelector("iframe");
    const sandbox = iframe?.getAttribute("sandbox");
    expect(sandbox).toBe("allow-scripts");
    // Critical security guarantee — must not include allow-same-origin.
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("uses srcdoc (not src) to host the HTML", () => {
    const { container } = render(<ArtifactHtml artifact={htmlArtifact("<p>via srcdoc</p>")} />);
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toBeNull();
    const srcdoc = iframe?.getAttribute("srcdoc");
    expect(srcdoc).not.toBeNull();
    expect(srcdoc).toContain("<p>via srcdoc</p>");
    // The size-bridge script is injected into the srcdoc.
    expect(srcdoc).toContain("artifact-resize");
  });

  it("renders the title and source in the card header", () => {
    const { container } = render(
      <ArtifactHtml artifact={htmlArtifact("<p>x</p>", { title: "MyChart", source: "viz" })} />,
    );
    expect(container.querySelector(".artifact-card-title")?.textContent).toBe("MyChart");
    expect(container.querySelector(".artifact-card-source")?.textContent).toBe("viz");
  });

  it("updates iframe height when receiving an artifact-resize postMessage", () => {
    const { container } = render(<ArtifactHtml artifact={htmlArtifact("<p>resize</p>")} />);
    const iframe = container.querySelector("iframe") as HTMLIFrameElement | null;
    expect(iframe).not.toBeNull();

    // Initial default height.
    expect(iframe?.style.height).toBe("240px");

    // Simulate the iframe posting up its measured height. The component checks
    // event.source === iframe.contentWindow, so we pass that as the source.
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "artifact-resize", height: 800 },
          source: iframe?.contentWindow,
        }),
      );
    });
    expect(iframe?.style.height).toBe("800px");

    // Above MAX (1600) clamps to MAX.
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "artifact-resize", height: 5000 },
          source: iframe?.contentWindow,
        }),
      );
    });
    expect(iframe?.style.height).toBe("1600px");

    // Below DEFAULT clamps up to DEFAULT.
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "artifact-resize", height: 50 },
          source: iframe?.contentWindow,
        }),
      );
    });
    expect(iframe?.style.height).toBe("240px");
  });

  it("ignores postMessages from other sources", () => {
    const { container } = render(<ArtifactHtml artifact={htmlArtifact("<p>x</p>")} />);
    const iframe = container.querySelector("iframe") as HTMLIFrameElement | null;

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "artifact-resize", height: 999 },
          source: window, // not the iframe — ignored.
        }),
      );
    });
    expect(iframe?.style.height).toBe("240px");
  });
});
