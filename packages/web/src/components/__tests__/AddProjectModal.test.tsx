import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddProjectModal } from "@/components/AddProjectModal";

const mockPush = vi.fn();
const mockRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));

describe("AddProjectModal", () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockRefresh.mockReset();
    vi.restoreAllMocks();

    // jsdom's localStorage lacks setItem/getItem — provide a working implementation
    const store = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
        clear: () => store.clear(),
        get length() { return store.size; },
        key: (index: number) => [...store.keys()][index] ?? null,
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the hardened filesystem browse endpoint from the directory picker", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddProjectModal open onClose={vi.fn()} />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/filesystem/browse?path=~"),
    );
  });

  it("shows the server browse error and disables submit when browsing fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "path not found" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddProjectModal open onClose={vi.fn()} />);

    expect(await screen.findByText(/path not found/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^add project$/i })).toBeDisabled();
  });

  it("blocks adding non-repo directories", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [{ name: "downloads", isDirectory: true, isGitRepo: false, hasLocalConfig: false }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddProjectModal open onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /downloads/i }));

    expect(await screen.findByText(/selected folder is not a git repository/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^add project$/i })).toBeDisabled();
  });

  it("offers opening the existing project or using a suffixed project ID when the server returns 409", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [{ name: "second-app", isDirectory: true, isGitRepo: true, hasLocalConfig: false }],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        entries: [{ name: "second-app", isDirectory: true, isGitRepo: true, hasLocalConfig: false }],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'Project ID "second-app" is already registered.',
        existingProjectId: "existing-app",
        suggestedProjectId: "second-app-1",
        suggestion: "choose-project-id",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddProjectModal open onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /second-app/i }));
    fireEvent.click(screen.getByRole("button", { name: /^add project$/i }));

    expect(
      await screen.findByRole("button", { name: /open existing/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /use suggested id/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/project id/i)).toHaveValue("second-app-1");
  });

  it("retries with the suggested project ID when requested", async () => {
    const onClose = vi.fn();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        entries: [{ name: "my-app", isDirectory: true, isGitRepo: true, hasLocalConfig: false }],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'Project ID "my-app" is already registered.',
        existingProjectId: "existing-app",
        suggestedProjectId: "my-app-1",
        suggestion: "choose-project-id",
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, projectId: "my-app-1" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddProjectModal open onClose={onClose} />);

    fireEvent.click(await screen.findByRole("button", { name: /my-app/i }));
    fireEvent.click(screen.getByRole("button", { name: /^add project$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /use suggested id/i }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/projects/my-app-1"));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/projects",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          projectId: "my-app-1",
          name: "My App",
          path: "~/my-app",
          useDefaultProjectId: true,
        }),
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("pushes directly to the new project after a successful POST", async () => {
    const onClose = vi.fn();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        entries: [{ name: "my-app", isDirectory: true, isGitRepo: true, hasLocalConfig: false }],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, projectId: "my-app" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddProjectModal open onClose={onClose} />);

    fireEvent.click(await screen.findByRole("button", { name: /my-app/i }));
    fireEvent.click(screen.getByRole("button", { name: /^add project$/i }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/projects/my-app"));
    expect(onClose).toHaveBeenCalled();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("lets the user customize project id and name before submitting", async () => {
    const onClose = vi.fn();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        entries: [{ name: "my-app", isDirectory: true, isGitRepo: true, hasLocalConfig: false }],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, projectId: "docs-app-alt" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddProjectModal open onClose={onClose} />);

    fireEvent.click(await screen.findByRole("button", { name: /my-app/i }));
    fireEvent.change(screen.getByLabelText(/project id/i), { target: { value: "docs-app-alt" } });
    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: "Docs App Alt" } });
    fireEvent.click(screen.getByRole("button", { name: /^add project$/i }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/projects/docs-app-alt"));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/projects",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          projectId: "docs-app-alt",
          name: "Docs App Alt",
          path: "~/my-app",
          useDefaultProjectId: false,
        }),
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });
});
