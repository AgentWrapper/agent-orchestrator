import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChangedFileList } from "../ChangedFileList";

vi.mock("../useFileTree", () => ({
  useFileTree: vi.fn(),
}));

vi.mock("../fileIcons", () => ({
  getFileIcon: vi.fn(() => () => null),
}));

import { useFileTree } from "../useFileTree";

const mockUseFileTree = vi.mocked(useFileTree);

function defaultTreeReturn(gitStatus: Record<string, string> = {}) {
  return {
    tree: [],
    gitStatus: gitStatus as ReturnType<typeof useFileTree>["gitStatus"],
    baseRef: null,
    loading: false,
    error: null,
  };
}

describe("ChangedFileList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state when loading and no files", () => {
    mockUseFileTree.mockReturnValue({ ...defaultTreeReturn(), loading: true });
    render(
      <ChangedFileList sessionId="s1" selectedFile={null} onFileSelected={() => {}} />
    );
    expect(screen.getByText("Loading changes...")).toBeDefined();
  });

  it("shows empty state when no changed files", () => {
    mockUseFileTree.mockReturnValue(defaultTreeReturn());
    render(
      <ChangedFileList sessionId="s1" selectedFile={null} onFileSelected={() => {}} />
    );
    expect(screen.getByText("No changed files")).toBeDefined();
  });

  it("groups files by parent directory", () => {
    mockUseFileTree.mockReturnValue(
      defaultTreeReturn({
        "src/foo.ts": "M",
        "src/bar.ts": "A",
        "test/baz.ts": "M",
      })
    );
    render(
      <ChangedFileList sessionId="s1" selectedFile={null} onFileSelected={() => {}} />
    );
    expect(screen.getByText("src")).toBeDefined();
    expect(screen.getByText("test")).toBeDefined();
    expect(screen.getByText("foo.ts")).toBeDefined();
    expect(screen.getByText("bar.ts")).toBeDefined();
    expect(screen.getByText("baz.ts")).toBeDefined();
  });

  it("shows file count badge on group headers", () => {
    mockUseFileTree.mockReturnValue(
      defaultTreeReturn({ "src/a.ts": "M", "src/b.ts": "A" })
    );
    render(
      <ChangedFileList sessionId="s1" selectedFile={null} onFileSelected={() => {}} />
    );
    expect(screen.getByText("2")).toBeDefined();
  });

  it("shows status badge M/A/D/R for different statuses", () => {
    mockUseFileTree.mockReturnValue(
      defaultTreeReturn({
        "a/mod.ts": "M",
        "a/add.ts": "A",
        "a/del.ts": "D",
        "a/ren.ts": "R",
        "a/untracked.ts": "?",
      })
    );
    render(
      <ChangedFileList sessionId="s1" selectedFile={null} onFileSelected={() => {}} />
    );
    const statuses = screen.getAllByText(/^[MADR?]$/);
    // ? renders as A
    const statusTexts = statuses.map((s) => s.textContent);
    expect(statusTexts).toContain("M");
    expect(statusTexts).toContain("A");
    expect(statusTexts).toContain("D");
    expect(statusTexts).toContain("R");
  });

  it("calls onFileSelected with full path when a file row is clicked", () => {
    const onFileSelected = vi.fn();
    mockUseFileTree.mockReturnValue(
      defaultTreeReturn({ "src/index.ts": "M" })
    );
    render(
      <ChangedFileList sessionId="s1" selectedFile={null} onFileSelected={onFileSelected} />
    );
    fireEvent.click(screen.getByText("index.ts"));
    expect(onFileSelected).toHaveBeenCalledWith("src/index.ts");
  });

  it("marks selected file with aria-selected and selected class", () => {
    mockUseFileTree.mockReturnValue(
      defaultTreeReturn({ "src/index.ts": "M" })
    );
    const { container } = render(
      <ChangedFileList sessionId="s1" selectedFile="src/index.ts" onFileSelected={() => {}} />
    );
    const selected = container.querySelector("[aria-selected='true']");
    expect(selected).toBeTruthy();
    expect(selected?.className).toContain("changed-file-list-file--selected");
  });

  it("collapses and expands a group when header is clicked", () => {
    mockUseFileTree.mockReturnValue(
      defaultTreeReturn({ "src/index.ts": "M" })
    );
    render(
      <ChangedFileList sessionId="s1" selectedFile={null} onFileSelected={() => {}} />
    );
    // File is visible initially
    expect(screen.getByText("index.ts")).toBeDefined();
    // Click header to collapse
    fireEvent.click(screen.getByText("src"));
    expect(screen.queryByText("index.ts")).toBeNull();
    // Click again to expand
    fireEvent.click(screen.getByText("src"));
    expect(screen.getByText("index.ts")).toBeDefined();
  });

  it("calls onBaseRefChange when baseRef changes", () => {
    const onBaseRefChange = vi.fn();
    mockUseFileTree.mockReturnValue({ ...defaultTreeReturn(), baseRef: "origin/main" });
    render(
      <ChangedFileList
        sessionId="s1"
        selectedFile={null}
        onFileSelected={() => {}}
        onBaseRefChange={onBaseRefChange}
      />
    );
    expect(onBaseRefChange).toHaveBeenCalledWith("origin/main");
  });

  it("handles keyboard Enter to select file", () => {
    const onFileSelected = vi.fn();
    mockUseFileTree.mockReturnValue(
      defaultTreeReturn({ "src/index.ts": "M" })
    );
    render(
      <ChangedFileList sessionId="s1" selectedFile={null} onFileSelected={onFileSelected} />
    );
    const fileRow = screen.getByText("index.ts").closest("[role='treeitem']");
    expect(fileRow).toBeTruthy();
    fireEvent.keyDown(fileRow!, { key: "Enter" });
    expect(onFileSelected).toHaveBeenCalledWith("src/index.ts");
  });

  it("handles root-level files (no parent dir) in a group", () => {
    mockUseFileTree.mockReturnValue(
      defaultTreeReturn({ "README.md": "M" })
    );
    render(
      <ChangedFileList sessionId="s1" selectedFile={null} onFileSelected={() => {}} />
    );
    expect(screen.getByText("(root)")).toBeDefined();
    expect(screen.getByText("README.md")).toBeDefined();
  });
});
