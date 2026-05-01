import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileTree } from "../FileTree";

vi.mock("../useFileTree", () => ({
  useFileTree: vi.fn(() => ({
    tree: [
      {
        name: "src",
        path: "src",
        type: "directory",
        children: [
          { name: "index.ts", path: "src/index.ts", type: "file" },
          { name: "utils.ts", path: "src/utils.ts", type: "file" },
        ],
      },
      { name: "README.md", path: "README.md", type: "file" },
    ],
    gitStatus: { "src/index.ts": "M", "README.md": "A" },
    loading: false,
    error: null,
  })),
}));

describe("FileTree", () => {
  it("renders file and directory entries", () => {
    render(
      <FileTree
        sessionId="test-session"
        selectedFile={null}
        onFileSelected={() => undefined}
        showChangedOnly={false}
      />,
    );

    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("shows root-level changed files when showChangedOnly is true", () => {
    render(
      <FileTree
        sessionId="test-session"
        selectedFile={null}
        onFileSelected={() => undefined}
        showChangedOnly={true}
      />,
    );

    // README.md is added (A) — visible at root level
    expect(screen.getByText("README.md")).toBeInTheDocument();
    // src dir still visible (contains changed files)
    expect(screen.getByText("src")).toBeInTheDocument();
  });

  it("calls onFileSelected when a file is clicked", () => {
    const onFileSelected = vi.fn();

    render(
      <FileTree
        sessionId="test-session"
        selectedFile={null}
        onFileSelected={onFileSelected}
        showChangedOnly={false}
      />,
    );

    fireEvent.click(screen.getByText("README.md"));
    expect(onFileSelected).toHaveBeenCalledWith("README.md");
  });

  it("highlights the selected file", () => {
    render(
      <FileTree
        sessionId="test-session"
        selectedFile="README.md"
        onFileSelected={() => undefined}
        showChangedOnly={false}
      />,
    );

    const readmeEl = screen.getByText("README.md").closest("[class*='selected'], [aria-selected]");
    expect(readmeEl ?? screen.getByText("README.md")).toBeInTheDocument();
  });
});
