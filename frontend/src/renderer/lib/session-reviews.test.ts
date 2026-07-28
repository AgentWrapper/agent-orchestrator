import { describe, expect, it } from "vitest";
import type { WorkspaceSession } from "../types/workspace";
import { sessionReviewsQueryOptions } from "./session-reviews";

function session(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    workspaceId: "proj-1",
    workspaceName: "app",
    title: "review work",
    provider: "codex",
    kind: "worker",
    branch: "feature/review-work",
    status: "pr_open",
    updatedAt: "2026-06-10T00:00:00Z",
    prs: [],
    id: "session-1",
    ...overrides,
  };
}

describe("sessionReviewsQueryOptions", () => {
  it("owns the shared reviews query key", () => {
    expect(sessionReviewsQueryOptions(session(), true).queryKey).toEqual([
      "session-reviews",
      "session-1",
    ]);
  });

  it("lets callers opt into a longer staleTime", () => {
    expect(
      sessionReviewsQueryOptions(session(), true).staleTime,
    ).toBeUndefined();
    expect(sessionReviewsQueryOptions(session(), true, 60_000).staleTime).toBe(
      60_000,
    );
  });
});
