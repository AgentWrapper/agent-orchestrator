import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectoryBrowser } from "@/components/DirectoryBrowser";
import { useDirectoryBrowser } from "@/hooks/useDirectoryBrowser";
import type { UseDirectoryBrowser } from "@/hooks/useDirectoryBrowser";

function Harness() {
  const browser = useDirectoryBrowser();
  useEffect(() => {
    browser.reset();
  }, [browser.reset]);
  return <DirectoryBrowser browser={browser} />;
}

describe("DirectoryBrowser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders folders from the browse API and selects on click", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          entries: [{ name: "my-repo", isDirectory: true, isGitRepo: true, hasLocalConfig: false }],
          roots: [],
        }),
      }),
    );

    render(<Harness />);

    const row = await screen.findByText("my-repo");
    fireEvent.click(row);

    await waitFor(() => expect(row.closest("button")?.className).toContain("is-selected"));
  });

  it("shows a git badge only for git-repo folders", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          entries: [
            { name: "repo", isDirectory: true, isGitRepo: true, hasLocalConfig: false },
            { name: "plain", isDirectory: true, isGitRepo: false, hasLocalConfig: false },
          ],
          roots: [],
        }),
      }),
    );

    render(<Harness />);

    const repoRow = await screen.findByRole("button", { name: "repo" });
    const plainRow = await screen.findByRole("button", { name: "plain" });

    expect(repoRow.querySelector(".add-project-browser__row-icon")).not.toBeNull();
    expect(plainRow.querySelector(".add-project-browser__row-icon")).not.toBeNull();
    expect(repoRow.querySelector(".add-project-browser__badge")).not.toBeNull();
    expect(plainRow.querySelector(".add-project-browser__badge")).toBeNull();
  });

  it("renders breadcrumb segments and navigates on crumb click", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [], roots: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Harness />);

    await waitFor(() => expect(screen.getByText("home")).toBeInTheDocument());
    fetchMock.mockClear();
    fireEvent.click(screen.getByText("home"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/filesystem/browse?path=~"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets focused breadcrumb Enter activate the crumb instead of descending into the selected folder", () => {
    const browser = {
      browsePath: "~/workspace",
      selectedBrowsePath: "~/workspace/alpha",
      setSelectedBrowsePath: vi.fn(),
      directoryEntries: [{ name: "alpha", isDirectory: true, isGitRepo: false, hasLocalConfig: false }],
      currentDirectory: null,
      roots: [],
      selectedRootPath: "",
      locationInput: "~/workspace",
      setLocationInput: vi.fn(),
      loading: false,
      error: null,
      parentPath: "~",
      canGoBack: false,
      canGoForward: false,
      browse: vi.fn(),
      goBack: vi.fn(),
      goForward: vi.fn(),
      goUp: vi.fn(),
      refresh: vi.fn(),
      reset: vi.fn(),
    } satisfies UseDirectoryBrowser;

    render(<DirectoryBrowser browser={browser} />);

    const homeCrumb = screen.getByRole("button", { name: "home" });
    homeCrumb.focus();
    fireEvent.keyDown(homeCrumb, { key: "Enter" });
    fireEvent.click(homeCrumb);

    expect(browser.browse).toHaveBeenCalledWith("~");
    expect(browser.browse).not.toHaveBeenCalledWith("~/workspace/alpha");
  });

  it("selects a folder with ArrowDown and descends with Enter", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [
          { name: "alpha", isDirectory: true, isGitRepo: false, hasLocalConfig: false },
          { name: "beta", isDirectory: true, isGitRepo: false, hasLocalConfig: false },
        ],
        roots: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Harness />);

    const row = (await screen.findByText("alpha")).closest("button");
    expect(row).not.toBeNull();

    fireEvent.keyDown(row!, { key: "ArrowDown" });
    await waitFor(() => expect(row?.className).toContain("is-selected"));

    fireEvent.keyDown(row!, { key: "Enter" });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/filesystem/browse?path=~%2Falpha"),
    );
  });

  it("jumps selection to a folder by typeahead", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          entries: [
            { name: "apple", isDirectory: true, isGitRepo: false, hasLocalConfig: false },
            { name: "banana", isDirectory: true, isGitRepo: false, hasLocalConfig: false },
            { name: "cherry", isDirectory: true, isGitRepo: false, hasLocalConfig: false },
          ],
          roots: [],
        }),
      }),
    );

    render(<Harness />);

    const row = (await screen.findByText("banana")).closest("button");
    expect(row).not.toBeNull();
    row!.focus();
    fireEvent.keyDown(row!, { key: "b" });

    await waitFor(() => expect(row?.className).toContain("is-selected"));
  });

  it("does not descend on modified Enter when a folder is selected", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [{ name: "my-repo", isDirectory: true, isGitRepo: true, hasLocalConfig: false }],
        roots: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Harness />);

    const row = (await screen.findByText("my-repo")).closest("button");
    expect(row).not.toBeNull();
    fireEvent.click(row!);
    await waitFor(() => expect(row?.className).toContain("is-selected"));

    fireEvent.keyDown(row!, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(row!, { key: "Enter", metaKey: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores keyboard events from outside the browser", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          entries: [{ name: "my-repo", isDirectory: true, isGitRepo: true, hasLocalConfig: false }],
          roots: [],
        }),
      }),
    );

    render(
      <>
        <button type="button">Outside</button>
        <Harness />
      </>,
    );

    const outside = await screen.findByText("Outside");
    const row = await screen.findByText("my-repo");
    outside.focus();

    fireEvent.keyDown(outside, { key: "ArrowDown" });

    expect(row.closest("button")?.className).not.toContain("is-selected");
  });

  it("does not reset the browser on mount", () => {
    const browser = {
      browsePath: "~",
      selectedBrowsePath: "~",
      setSelectedBrowsePath: vi.fn(),
      directoryEntries: [],
      currentDirectory: null,
      roots: [],
      selectedRootPath: "",
      locationInput: "~",
      setLocationInput: vi.fn(),
      loading: false,
      error: null,
      parentPath: null,
      canGoBack: false,
      canGoForward: false,
      browse: vi.fn(),
      goBack: vi.fn(),
      goForward: vi.fn(),
      goUp: vi.fn(),
      refresh: vi.fn(),
      reset: vi.fn(),
    } satisfies UseDirectoryBrowser;

    render(<DirectoryBrowser browser={browser} />);

    expect(browser.reset).not.toHaveBeenCalled();
  });
});
