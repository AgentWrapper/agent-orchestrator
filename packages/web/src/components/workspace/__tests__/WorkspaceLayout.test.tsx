import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceLayout } from "../WorkspaceLayout";
import { makeSession } from "../../../__tests__/helpers";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));

vi.mock("../useFileTree", () => ({
  useFileTree: vi.fn(() => ({ tree: [], gitStatus: {}, loading: false, error: null })),
}));

vi.mock("../useFileView", () => ({
  useFileView: vi.fn(() => ({ data: null, loading: false, error: null })),
}));

function makePaneControls() {
  return {
    sizes: [20, 40, 40],
    collapsed: [false, false, false],
    isHydrated: true,
    verticalLayout: false,
    verticalSplit: [60, 40] as [number, number],
    previewFontSize: 13,
    setSizes: vi.fn(),
    toggleCollapsed: vi.fn(),
    setVerticalLayout: vi.fn(),
    setVerticalSplit: vi.fn(),
    setPreviewFontSize: vi.fn(),
  };
}

describe("WorkspaceLayout", () => {
  const session = makeSession({ id: "test-ws-session" });

  it("renders the terminal pane content", () => {
    render(
      <WorkspaceLayout session={session} paneControls={makePaneControls()}>
        {{
          fileTree: () => <div>file-tree-content</div>,
          preview: () => <div>preview-content</div>,
          terminal: <div data-testid="terminal-content">terminal-here</div>,
        }}
      </WorkspaceLayout>,
    );

    expect(screen.getByTestId("terminal-content")).toBeInTheDocument();
  });

  it("renders the file tree pane when not collapsed", () => {
    render(
      <WorkspaceLayout session={session} paneControls={makePaneControls()}>
        {{
          fileTree: () => <div data-testid="tree-content">files</div>,
          preview: () => null,
          terminal: <div />,
        }}
      </WorkspaceLayout>,
    );

    expect(screen.getByTestId("tree-content")).toBeInTheDocument();
  });

  it("hides the file tree pane when collapsed", () => {
    const controls = makePaneControls();
    controls.collapsed = [true, false, false];
    render(
      <WorkspaceLayout session={session} paneControls={controls}>
        {{
          fileTree: () => <div data-testid="tree-content">files</div>,
          preview: () => null,
          terminal: <div />,
        }}
      </WorkspaceLayout>,
    );

    expect(screen.queryByTestId("tree-content")).not.toBeInTheDocument();
  });
});
