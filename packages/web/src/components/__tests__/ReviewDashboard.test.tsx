import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewDashboard } from "../ReviewDashboard";
import type { DashboardReviewRun } from "@/lib/review-types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/review",
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({
    resolvedTheme: "light",
    setTheme: vi.fn(),
  }),
}));

function makeRun(overrides: Partial<DashboardReviewRun>): DashboardReviewRun {
  return {
    id: "review-run-1",
    projectId: "my-app",
    projectName: "My App",
    linkedSessionId: "app-1",
    reviewerSessionId: "app-rev-1",
    status: "needs_triage",
    createdAt: "2026-05-10T10:00:00.000Z",
    updatedAt: "2026-05-10T10:01:00.000Z",
    findingCount: 2,
    openFindingCount: 1,
    dismissedFindingCount: 1,
    sentFindingCount: 0,
    resolvedFindingCount: 0,
    workerTitle: "Add todo filters",
    workerBranch: "feat/todo-filters",
    workerPrUrl: "https://github.com/acme/todo/pull/7",
    workerStatus: "review_pending",
    workerActivity: "idle",
    workerRuntimeState: "alive",
    workerHasRuntime: true,
    ...overrides,
  };
}

describe("ReviewDashboard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders review runs in review-specific columns", () => {
    render(
      <ReviewDashboard
        runs={[
          makeRun({ status: "needs_triage" }),
          makeRun({
            id: "review-run-2",
            reviewerSessionId: "app-rev-2",
            linkedSessionId: "app-2",
            status: "running",
            workerTitle: "Persist completed todos",
            findingCount: 0,
            openFindingCount: 0,
            dismissedFindingCount: 0,
          }),
        ]}
        projectId="my-app"
        projectName="My App"
        projects={[{ id: "my-app", name: "My App", path: "/tmp/my-app" }]}
      />,
    );

    expect(screen.getByRole("heading", { name: "My App Reviews" })).toBeInTheDocument();
    expect(screen.getByText("Triage")).toBeInTheDocument();
    expect(screen.getByText("Reviewing")).toBeInTheDocument();
    expect(screen.getByText("Add todo filters")).toBeInTheDocument();
    expect(screen.getByText("Persist completed todos")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1 open finding/i })).toBeInTheDocument();
    const workerLinks = screen.getAllByRole("link", { name: "Worker" });
    expect(
      workerLinks.some((link) => link.getAttribute("href") === "/projects/my-app?session=app-1"),
    ).toBe(true);
  });

  it("renders an empty state when there are no review runs", () => {
    render(
      <ReviewDashboard
        runs={[]}
        projectId="my-app"
        projectName="My App"
        projects={[{ id: "my-app", name: "My App", path: "/tmp/my-app" }]}
      />,
    );

    expect(screen.getByText("No review runs yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to coding dashboard" })).toHaveAttribute(
      "href",
      "/projects/my-app",
    );
  });

  it("can execute multiple queued review runs without a board-wide lock", async () => {
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>(() => {
          // Keep requests pending so the test can assert simultaneous in-flight runs.
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ReviewDashboard
        runs={[
          makeRun({
            id: "review-run-1",
            reviewerSessionId: "app-rev-1",
            linkedSessionId: "app-1",
            status: "queued",
            findingCount: 0,
            openFindingCount: 0,
            dismissedFindingCount: 0,
          }),
          makeRun({
            id: "review-run-2",
            reviewerSessionId: "app-rev-2",
            linkedSessionId: "app-2",
            status: "queued",
            findingCount: 0,
            openFindingCount: 0,
            dismissedFindingCount: 0,
          }),
        ]}
        projectId="my-app"
        projectName="My App"
        projects={[{ id: "my-app", name: "My App", path: "/tmp/my-app" }]}
      />,
    );

    const runButtons = screen.getAllByRole("button", { name: "Run" });
    fireEvent.click(runButtons[0]);
    await screen.findByRole("button", { name: "Running" });

    fireEvent.click(runButtons[1]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("surfaces a completed failed review run as a failure", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        run: makeRun({
          id: "review-run-1",
          reviewerSessionId: "app-rev-1",
          status: "failed",
          findingCount: 0,
          openFindingCount: 0,
          dismissedFindingCount: 0,
          terminationReason: "Codex review failed: invalid arguments",
        }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ReviewDashboard
        runs={[
          makeRun({
            id: "review-run-1",
            reviewerSessionId: "app-rev-1",
            linkedSessionId: "app-1",
            status: "queued",
            findingCount: 0,
            openFindingCount: 0,
            dismissedFindingCount: 0,
          }),
        ]}
        projectId="my-app"
        projectName="My App"
        projects={[{ id: "my-app", name: "My App", path: "/tmp/my-app" }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(
      await screen.findByText(/Review failed: Codex review failed: invalid arguments/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Review completed clean")).not.toBeInTheDocument();
  });
});
