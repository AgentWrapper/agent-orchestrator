import { act, render, screen, cleanup } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardSession } from "@/lib/types";
import type { SessionPatch } from "@/lib/mux-protocol";

const sessionDetailSpy = vi.fn();
const replaceSpy = vi.fn();
let mockPathname = "/projects/my-app/sessions/worker-1";
let mockParams: Record<string, string> = { id: "worker-1" };
const mockMuxState: {
  current?: {
    sessions: SessionPatch[];
    status?: "connecting" | "connected" | "reconnecting" | "disconnected";
  };
} = {};

vi.mock("next/navigation", () => ({
  useParams: () => mockParams,
  usePathname: () => mockPathname,
  useRouter: () => ({ replace: replaceSpy }),
}));

vi.mock("@/providers/MuxProvider", () => ({
  useMuxOptional: () => mockMuxState.current,
}));

vi.mock("@/components/SessionDetail", () => ({
  SessionDetail: (props: unknown) => {
    sessionDetailSpy(props);
    return <div data-testid="session-detail" />;
  },
}));

vi.mock("@/hooks/useMuxSessionActivity", () => ({
  useMuxSessionActivity: () => null,
}));

function makeWorkerSession(): DashboardSession {
  return {
    id: "worker-1",
    projectId: "my-app",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: "https://linear.app/test/issue/INT-100",
    issueUrl: "https://linear.app/test/issue/INT-100",
    issueLabel: "INT-100",
    summary: "Test worker session",
    summaryIsFallback: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
    agentReportAudit: [],
  };
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("SessionPage project polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    sessionDetailSpy.mockClear();
    replaceSpy.mockClear();
    mockPathname = "/projects/my-app/sessions/worker-1";
    mockParams = { id: "worker-1", projectId: "my-app" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockMuxState.current = undefined;

    const eventSourceMock = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
      readyState: 1,
    };
    global.EventSource = vi.fn(
      () => eventSourceMock as unknown as EventSource,
    ) as unknown as typeof EventSource;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves orchestrator nav once for non-orchestrator pages and skips repeated project polling", async () => {
    const workerSession = makeWorkerSession();
    const sidebarSessions = [workerSession];

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{ id: "my-app", name: "My App", sessionPrefix: "my-app" }],
          }),
        } as Response;
      }

      if (url === "/api/sessions/worker-1") {
        return {
          ok: true,
          status: 200,
          json: async () => workerSession,
        } as Response;
      }

      if (url === "/api/sessions?fresh=true") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessions: sidebarSessions }),
        } as Response;
      }

      if (url === "/api/sessions?project=my-app&orchestratorOnly=true&fresh=true") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            orchestratorId: "my-app-orchestrator",
            orchestrators: [
              {
                id: "my-app-orchestrator",
                projectId: "my-app",
                projectName: "My App",
              },
            ],
          }),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");

    render(<SessionPage />);
    await flushAsyncWork();

    expect(fetch).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions/worker-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions?fresh=true",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions?project=my-app&orchestratorOnly=true&fresh=true",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([url]) => url === "/api/sessions?project=my-app&orchestratorOnly=true&fresh=true",
        ),
    ).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await flushAsyncWork();

    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([url]) => url === "/api/sessions?project=my-app&orchestratorOnly=true&fresh=true",
        ),
    ).toHaveLength(1);

    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/sessions?fresh=true"),
    ).toHaveLength(3);
  });

  it("does not deadlock project polling after a cached worker poll is skipped", async () => {
    const workerSession = makeWorkerSession();
    let sessionFetchCount = 0;

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{ id: "my-app", name: "My App", sessionPrefix: "my-app" }],
          }),
        } as Response;
      }

      if (url === "/api/sessions/worker-1") {
        sessionFetchCount += 1;
        return {
          ok: true,
          status: 200,
          json: async () =>
            sessionFetchCount >= 3
              ? { ...workerSession, metadata: { role: "orchestrator" } }
              : workerSession,
        } as Response;
      }

      if (url === "/api/sessions?fresh=true") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessions: [workerSession] }),
        } as Response;
      }

      if (url === "/api/sessions?project=my-app&orchestratorOnly=true&fresh=true") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ orchestratorId: "my-app-orchestrator" }),
        } as Response;
      }

      if (url === "/api/sessions?project=my-app&fresh=true") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessions: [workerSession], orchestratorId: "worker-1" }),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");

    render(<SessionPage />);
    await flushAsyncWork();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await flushAsyncWork();

    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions?project=my-app&fresh=true",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("renders an inline missing-session state instead of blanking the shell", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ projects: [] }),
        } as Response;
      }

      if (url === "/api/sessions/worker-1") {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");

    render(
      <TestErrorBoundary>
        <SessionPage />
      </TestErrorBoundary>,
    );
    await flushAsyncWork();

    expect(screen.getByText("Session not found")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle sidebar" })).toBeInTheDocument();
    expect(screen.queryByTestId("session-detail")).not.toBeInTheDocument();
    expect(screen.getByTestId("route-error")).toHaveTextContent("NEXT_NOT_FOUND");
  });

  it("renders an inline error state instead of throwing the route away", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ projects: [] }),
        } as Response;
      }

      if (url === "/api/sessions/worker-1") {
        return {
          ok: false,
          status: 500,
          json: async () => ({}),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");

    render(<SessionPage />);
    await flushAsyncWork();

    expect(screen.getByText("Failed to load session")).toBeInTheDocument();
    expect(screen.getByText(/internal error/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle sidebar" })).toBeInTheDocument();
  });

  it("times out a stuck session fetch and replaces the infinite loader with an error state", async () => {
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ projects: [] }),
        } as Response);
      }

      if (url === "/api/sessions/worker-1") {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }

      if (url === "/api/sessions?fresh=true") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ sessions: [] }),
        } as Response);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");

    render(<SessionPage />);

    expect(screen.getByText("Loading session…")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    await flushAsyncWork();

    expect(screen.getByText("Failed to load session")).toBeInTheDocument();
    expect(screen.getByText(/taking too long/i)).toBeInTheDocument();
    expect(screen.queryByText("Loading session…")).not.toBeInTheDocument();
  });

  it("shows a recoverable unavailable state when the first session request aborts", async () => {
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{ id: "my-app", name: "My App", sessionPrefix: "my-app" }],
          }),
        } as Response);
      }

      if (url === "/api/sessions/worker-1") {
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      }

      if (url === "/api/sessions?fresh=true") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ sessions: [] }),
        } as Response);
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");

    render(<SessionPage />);
    await flushAsyncWork();

    expect(screen.getByText("Session unavailable")).toBeInTheDocument();
    expect(screen.getByText(/backend has not returned this session yet/i)).toBeInTheDocument();
    expect(screen.queryByText("Loading session…")).not.toBeInTheDocument();
  });

  it("marks sidebar data as loading until the sessions list resolves", async () => {
    const workerSession = makeWorkerSession();
    let resolveSidebarSessions: ((value: Response) => void) | null = null;

    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{ id: "my-app", name: "My App", sessionPrefix: "my-app" }],
          }),
        } as Response);
      }

      if (url === "/api/sessions/worker-1") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => workerSession,
        } as Response);
      }

      if (url === "/api/sessions?fresh=true") {
        return new Promise<Response>((resolve) => {
          resolveSidebarSessions = resolve;
        });
      }

      if (url === "/api/sessions?project=my-app&orchestratorOnly=true&fresh=true") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ orchestratorId: "my-app-orchestrator" }),
        } as Response);
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");

    render(<SessionPage />);
    await flushAsyncWork();

    const latestBeforeSidebarResolve = sessionDetailSpy.mock.lastCall?.[0] as {
      sidebarLoading?: boolean;
      sidebarSessions?: DashboardSession[] | null;
    };

    expect(latestBeforeSidebarResolve.sidebarLoading).toBe(true);
    expect(latestBeforeSidebarResolve.sidebarSessions).toBeNull();

    await act(async () => {
      resolveSidebarSessions?.({
        ok: true,
        status: 200,
        json: async () => ({ sessions: [workerSession] }),
      } as Response);
      await Promise.resolve();
    });

    const latestAfterSidebarResolve = sessionDetailSpy.mock.lastCall?.[0] as {
      sidebarLoading?: boolean;
      sidebarSessions?: DashboardSession[] | null;
    };

    expect(latestAfterSidebarResolve.sidebarLoading).toBe(false);
    expect(latestAfterSidebarResolve.sidebarSessions).toEqual([workerSession]);
  });

  it("revalidates projects and sidebar sessions on remount even when cache exists", async () => {
    const workerSession = makeWorkerSession();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{ id: "my-app", name: "My App", sessionPrefix: "my-app" }],
          }),
        } as Response;
      }

      if (url === "/api/sessions/worker-1") {
        return {
          ok: true,
          status: 200,
          json: async () => workerSession,
        } as Response;
      }

      if (url === "/api/sessions?fresh=true") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessions: [workerSession] }),
        } as Response;
      }

      if (url === "/api/sessions?project=my-app&orchestratorOnly=true&fresh=true") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ orchestratorId: "my-app-orchestrator" }),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    const { default: SessionPage } = await import("./page");

    const firstRender = render(<SessionPage />);
    await flushAsyncWork();
    firstRender.unmount();

    render(<SessionPage />);
    await flushAsyncWork();

    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/projects")).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/sessions?fresh=true")).toHaveLength(
      2,
    );
  });

  it("silences aborted sidebar refreshes during unmount", async () => {
    const workerSession = makeWorkerSession();
    const consoleErrorSpy = vi.spyOn(console, "error");

    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{ id: "my-app", name: "My App", sessionPrefix: "my-app" }],
          }),
        } as Response);
      }

      if (url === "/api/sessions/worker-1") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => workerSession,
        } as Response);
      }

      if (url === "/api/sessions?project=my-app&orchestratorOnly=true&fresh=true") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ orchestratorId: "my-app-orchestrator" }),
        } as Response);
      }

      if (url === "/api/sessions?fresh=true") {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        });
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");

    const rendered = render(<SessionPage />);
    await flushAsyncWork();

    rendered.unmount();
    await flushAsyncWork();

    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      "Failed to fetch sidebar sessions:",
      expect.anything(),
    );
  });

  it("surfaces sidebar fetch failures instead of leaving the loading skeleton active", async () => {
    const workerSession = makeWorkerSession();

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{ id: "my-app", name: "My App", sessionPrefix: "my-app" }],
          }),
        } as Response;
      }

      if (url === "/api/sessions/worker-1") {
        return {
          ok: true,
          status: 200,
          json: async () => workerSession,
        } as Response;
      }

      if (url === "/api/sessions?fresh=true") {
        return {
          ok: false,
          status: 500,
          json: async () => ({}),
        } as Response;
      }

      if (url === "/api/sessions?project=my-app&orchestratorOnly=true&fresh=true") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ orchestratorId: "my-app-orchestrator" }),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");

    render(<SessionPage />);
    await flushAsyncWork();

    const latestProps = sessionDetailSpy.mock.lastCall?.[0] as {
      sidebarError?: boolean;
      sidebarLoading?: boolean;
      sidebarSessions?: DashboardSession[] | null;
    };

    expect(latestProps.sidebarLoading).toBe(false);
    expect(latestProps.sidebarError).toBe(true);
    expect(latestProps.sidebarSessions).toEqual([]);
  });

  it("applies mux snapshots that arrive before the initial sidebar fetch resolves", async () => {
    const workerSession = makeWorkerSession();
    const muxPatchedLastActivityAt = "2026-04-14T12:00:00.000Z";
    let resolveSidebarSessions: ((value: Response) => void) | null = null;

    mockMuxState.current = {
      status: "connected",
      sessions: [
        {
          id: "worker-1",
          status: "working",
          activity: "ready",
          attentionLevel: "pending",
          lastActivityAt: muxPatchedLastActivityAt,
        },
      ],
    };

    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{ id: "my-app", name: "My App", sessionPrefix: "my-app" }],
          }),
        } as Response);
      }

      if (url === "/api/sessions/worker-1") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => workerSession,
        } as Response);
      }

      if (url === "/api/sessions?fresh=true") {
        return new Promise<Response>((resolve) => {
          resolveSidebarSessions = resolve;
        });
      }

      if (url === "/api/sessions?project=my-app&orchestratorOnly=true&fresh=true") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ orchestratorId: "my-app-orchestrator" }),
        } as Response);
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");

    render(<SessionPage />);
    await flushAsyncWork();

    await act(async () => {
      resolveSidebarSessions?.({
        ok: true,
        status: 200,
        json: async () => ({ sessions: [workerSession] }),
      } as Response);
      await Promise.resolve();
    });

    const latestProps = sessionDetailSpy.mock.lastCall?.[0] as {
      sidebarSessions?: DashboardSession[] | null;
    };

    expect(latestProps.sidebarSessions).toEqual([
      {
        ...workerSession,
        activity: "ready",
        lastActivityAt: muxPatchedLastActivityAt,
      },
    ]);
  });

  it("redirects the legacy session URL to the project-scoped route for clean projects", async () => {
    mockPathname = "/sessions/worker-1";
    const workerSession = makeWorkerSession();

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{ id: "my-app", name: "My App", sessionPrefix: "my-app" }],
          }),
        } as Response;
      }

      if (url === "/api/sessions/worker-1") {
        return {
          ok: true,
          status: 200,
          json: async () => workerSession,
        } as Response;
      }

      if (url === "/api/sessions?fresh=true") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessions: [workerSession] }),
        } as Response;
      }

      if (url === "/api/sessions?project=my-app&orchestratorOnly=true&fresh=true") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ orchestratorId: null, orchestrators: [] }),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");
    render(<SessionPage />);
    await flushAsyncWork();

    expect(replaceSpy).toHaveBeenCalledWith("/projects/my-app/sessions/worker-1");
  });

  it("redirects the legacy session URL for degraded projects too", async () => {
    mockPathname = "/sessions/worker-1";
    mockParams = { id: "worker-1" };
    const workerSession = makeWorkerSession();
    workerSession.projectId = "broken-app";

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{ id: "broken-app", name: "broken-app", resolveError: "bad config" }],
          }),
        } as Response;
      }

      if (url === "/api/sessions/worker-1") {
        return {
          ok: true,
          status: 200,
          json: async () => workerSession,
        } as Response;
      }

      if (url === "/api/sessions?fresh=true") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessions: [workerSession] }),
        } as Response;
      }

      if (url === "/api/sessions?project=broken-app&orchestratorOnly=true&fresh=true") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ orchestratorId: null, orchestrators: [] }),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");
    render(<SessionPage />);
    await flushAsyncWork();

    expect(replaceSpy).toHaveBeenCalledWith("/projects/broken-app/sessions/worker-1");
  });

  it("redirects project-scoped routes to the owning project when the URL project id is wrong", async () => {
    mockPathname = "/projects/my-app/sessions/worker-1";
    mockParams = { id: "worker-1", projectId: "my-app" };
    const workerSession = makeWorkerSession();
    workerSession.projectId = "other-app";

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            projects: [
              { id: "my-app", name: "My App", sessionPrefix: "my-app" },
              { id: "other-app", name: "Other App", sessionPrefix: "other-app" },
            ],
          }),
        } as Response;
      }

      if (url === "/api/sessions/worker-1") {
        return {
          ok: true,
          status: 200,
          json: async () => workerSession,
        } as Response;
      }

      if (url === "/api/sessions?fresh=true") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessions: [workerSession] }),
        } as Response;
      }

      if (url === "/api/sessions?project=other-app&orchestratorOnly=true&fresh=true") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ orchestratorId: null, orchestrators: [] }),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");
    render(<SessionPage />);
    await flushAsyncWork();

    expect(replaceSpy).toHaveBeenCalledWith("/projects/other-app/sessions/worker-1");
  });
});
