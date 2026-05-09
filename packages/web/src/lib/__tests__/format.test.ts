/**
 * Tests for session title heuristic and branch humanization.
 */

import { describe, it, expect } from "vitest";
import { humanizeBranch, getSessionTitle } from "../format";
import type { DashboardSession } from "../types";

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

function makeSession(overrides?: Partial<DashboardSession>): DashboardSession {
  return {
    id: "ao-42",
    projectId: "test",
    status: "working",
    activity: "active",
    activitySignal: {
      state: "valid",
      activity: "active",
      timestamp: new Date().toISOString(),
      source: "native",
    },
    branch: null,
    issueId: null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: null,
    userPrompt: null,
    displayName: null,
    displayNameUserSet: false,
    summary: null,
    summaryIsFallback: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// humanizeBranch
// ---------------------------------------------------------------------------

describe("humanizeBranch", () => {
  it("strips common prefixes and title-cases", () => {
    expect(humanizeBranch("feat/infer-project-id")).toBe("Infer Project Id");
    expect(humanizeBranch("fix/broken-auth-flow")).toBe("Broken Auth Flow");
    expect(humanizeBranch("chore/update-deps")).toBe("Update Deps");
    expect(humanizeBranch("refactor/session-manager")).toBe("Session Manager");
    expect(humanizeBranch("docs/add-readme")).toBe("Add Readme");
    expect(humanizeBranch("test/add-coverage")).toBe("Add Coverage");
    expect(humanizeBranch("ci/fix-pipeline")).toBe("Fix Pipeline");
  });

  it("strips additional prefixes added for completeness", () => {
    expect(humanizeBranch("release/1.0.0")).toBe("1.0.0");
    expect(humanizeBranch("hotfix/urgent-patch")).toBe("Urgent Patch");
    expect(humanizeBranch("feature/new-dashboard")).toBe("New Dashboard");
    expect(humanizeBranch("bugfix/null-pointer")).toBe("Null Pointer");
    expect(humanizeBranch("build/docker-image")).toBe("Docker Image");
    expect(humanizeBranch("wip/experimental")).toBe("Experimental");
    expect(humanizeBranch("improvement/faster-queries")).toBe("Faster Queries");
  });

  it("handles session/ prefix", () => {
    expect(humanizeBranch("session/ao-52")).toBe("Ao 52");
  });

  it("handles orchestrator/ prefix", () => {
    expect(humanizeBranch("orchestrator/ao-orchestrator-8")).toBe("Ao Orchestrator 8");
  });

  it("returns empty when the branch is just the session ID (session/)", () => {
    // Signals to getSessionTitle that this branch carries no task info.
    expect(humanizeBranch("session/ao-42", "ao-42")).toBe("");
  });

  it("returns empty when the branch is just the session ID (orchestrator/)", () => {
    expect(humanizeBranch("orchestrator/ao-orchestrator-8", "ao-orchestrator-8")).toBe("");
  });

  it("keeps real content when the branch contains more than the session ID", () => {
    // feat/INT-1327 is a meaningful branch even if the session is ao-5.
    expect(humanizeBranch("feat/INT-1327", "ao-5")).toBe("INT 1327");
  });

  it("handles underscores", () => {
    expect(humanizeBranch("feat/add_new_feature")).toBe("Add New Feature");
  });

  it("handles branch with no prefix", () => {
    expect(humanizeBranch("main")).toBe("Main");
    expect(humanizeBranch("some-branch-name")).toBe("Some Branch Name");
  });

  it("handles branch with dots", () => {
    expect(humanizeBranch("release/v2.1.0")).toBe("V2.1.0");
  });

  it("handles empty string", () => {
    expect(humanizeBranch("")).toBe("");
  });

  it("does not strip unknown prefixes", () => {
    expect(humanizeBranch("custom/my-branch")).toBe("Custom/My Branch");
  });
});

// ---------------------------------------------------------------------------
// getSessionTitle — full fallback chain
// ---------------------------------------------------------------------------

describe("getSessionTitle", () => {
  it("returns PR title when available and no displayName is set", () => {
    const session = makeSession({
      summary: "Agent summary",
      issueTitle: "Issue title",
      branch: "feat/branch",
      pr: {
        number: 1,
        url: "https://github.com/test/repo/pull/1",
        title: "feat: add auth",
        owner: "test",
        repo: "repo",
        branch: "feat/branch",
        baseBranch: "main",
        isDraft: false,
        state: "open",
        additions: 10,
        deletions: 5,
        ciStatus: "passing",
        ciChecks: [],
        reviewDecision: "approved",
        mergeability: {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
        unresolvedThreads: 0,
        unresolvedComments: [],
      },
    });
    expect(getSessionTitle(session)).toBe("feat: add auth");
  });

  it("returns issue title over agent summary", () => {
    const session = makeSession({
      summary: "Implementing OAuth2 authentication with JWT tokens",
      summaryIsFallback: false,
      issueTitle: "Add user authentication",
      branch: "feat/auth",
    });
    expect(getSessionTitle(session)).toBe("Add user authentication");
  });

  it("skips fallback summaries in favor of issue title", () => {
    const session = makeSession({
      summary: "You are working on GitHub issue #42: Add authentication to API...",
      summaryIsFallback: true,
      issueTitle: "Add authentication to API",
      branch: "feat/issue-42",
    });
    expect(getSessionTitle(session)).toBe("Add authentication to API");
  });

  it("uses branch before fallback summary when no issue title is available", () => {
    const session = makeSession({
      summary: "You are working on GitHub issue #42: Add authentication to API...",
      summaryIsFallback: true,
      issueTitle: null,
      branch: "feat/issue-42",
    });
    expect(getSessionTitle(session)).toBe("Issue 42");
  });

  it("returns issue title when no summary exists", () => {
    const session = makeSession({
      summary: null,
      issueTitle: "Add user authentication",
      branch: "feat/auth",
    });
    expect(getSessionTitle(session)).toBe("Add user authentication");
  });

  it("returns humanized branch when no summary or issue title", () => {
    const session = makeSession({
      summary: null,
      issueTitle: null,
      branch: "feat/infer-project-id",
    });
    expect(getSessionTitle(session)).toBe("Infer Project Id");
  });

  it("prefers user-set displayName above every other signal (rename wins)", () => {
    // When displayNameUserSet is true, the user has explicitly renamed this
    // session and their label must beat live PR / issue titles.
    const session = makeSession({
      displayName: "PR 1466 review",
      displayNameUserSet: true,
      issueTitle: "Add user authentication",
      branch: "feat/auth",
      pr: {
        number: 1466,
        title: "feat: add auth",
        url: "https://github.com/x/y/pull/1466",
        state: "open",
      } as DashboardSession["pr"],
    });
    expect(getSessionTitle(session)).toBe("PR 1466 review");
  });

  it("does NOT promote auto-derived displayName above PR title", () => {
    // Spawn-time auto-derived displayName must not shadow a live PR title —
    // a stale spawn label would make sessions hard to identify days later.
    const session = makeSession({
      displayName: "Auto-derived at spawn",
      displayNameUserSet: false,
      issueTitle: "Add user authentication",
      branch: "feat/auth",
      pr: {
        number: 1466,
        title: "feat: add auth",
        url: "https://github.com/x/y/pull/1466",
        state: "open",
      } as DashboardSession["pr"],
    });
    expect(getSessionTitle(session)).toBe("feat: add auth");
  });

  it("does NOT promote auto-derived displayName above issue title", () => {
    const session = makeSession({
      displayName: "Auto-derived at spawn",
      displayNameUserSet: false,
      issueTitle: "Add user authentication",
      branch: "feat/auth",
    });
    expect(getSessionTitle(session)).toBe("Add user authentication");
  });

  it("returns displayName when no PR / issue title / user prompt", () => {
    const session = makeSession({
      id: "ao-5",
      summary: null,
      issueTitle: null,
      userPrompt: null,
      displayName: "Add OAuth2 refresh token support",
      branch: "feat/auth-refresh",
    });
    expect(getSessionTitle(session)).toBe("Add OAuth2 refresh token support");
  });

  it("prefers cleaned displayName over raw userPrompt for prompt-only sessions", () => {
    // Regression: both `userPrompt` and `displayName` come from the same
    // `spawnConfig.prompt` for prompt-only sessions. `userPrompt` stores the
    // raw multi-line prompt; `displayName` is the single-line 80-char-
    // truncated version. If `userPrompt` were checked first, kanban cards
    // would show the raw multi-line text and the deriveDisplayName cleanup
    // would never surface.
    const session = makeSession({
      id: "ao-42",
      summary: null,
      issueTitle: null,
      userPrompt: "Add rate limiting to /api/upload\n\nUse a sliding-window counter keyed by IP.",
      displayName: "Add rate limiting to /api/upload",
      branch: "session/ao-42",
    });
    expect(getSessionTitle(session)).toBe("Add rate limiting to /api/upload");
  });

  it("falls through to raw userPrompt when displayName is absent", () => {
    // Backwards-compat safety net for sessions spawned before displayName.
    const session = makeSession({
      summary: null,
      issueTitle: null,
      displayName: null,
      userPrompt: "Fix the race condition",
      branch: "session/ao-42",
      id: "ao-42",
    });
    expect(getSessionTitle(session)).toBe("Fix the race condition");
  });

  it("prefers issue title over auto-derived displayName when both are present", () => {
    // Auto-derived displayName must stay below live tracker titles so a stale
    // spawn-time value doesn't shadow the current issue title.
    const session = makeSession({
      issueTitle: "Live issue title",
      displayName: "Stale captured display name",
      displayNameUserSet: false,
      branch: "feat/auth",
    });
    expect(getSessionTitle(session)).toBe("Live issue title");
  });

  it("prefers displayName over a noisy orchestrator branch fallback", () => {
    // Repro of the original bug: an orchestrator used to render as
    // "Orchestrator/Ao Orchestrator 8". displayName fixes that.
    const session = makeSession({
      id: "ao-orchestrator-8",
      summary: null,
      issueTitle: null,
      userPrompt: null,
      displayName: "Audit test coverage for session-manager",
      branch: "orchestrator/ao-orchestrator-8",
    });
    expect(getSessionTitle(session)).toBe("Audit test coverage for session-manager");
  });

  it("skips branch fallback when it is just the session ID and falls through to summary", () => {
    const session = makeSession({
      id: "ao-42",
      summary: "Exploring the cache invalidation path",
      summaryIsFallback: false,
      issueTitle: null,
      userPrompt: null,
      displayName: null,
      branch: "session/ao-42",
    });
    // The branch "session/ao-42" would previously have rendered as "Ao 42".
    // Now it returns empty and we fall through to the quality summary.
    expect(getSessionTitle(session)).toBe("Exploring the cache invalidation path");
  });

  it("skips branch fallback when it is just the orchestrator session ID", () => {
    const session = makeSession({
      id: "ao-orchestrator-8",
      summary: null,
      issueTitle: null,
      userPrompt: null,
      displayName: null,
      branch: "orchestrator/ao-orchestrator-8",
      status: "working",
    });
    // No other signal: fall all the way to status.
    expect(getSessionTitle(session)).toBe("working");
  });

  it("returns status as absolute last resort", () => {
    const session = makeSession({
      summary: null,
      issueTitle: null,
      branch: null,
    });
    expect(getSessionTitle(session)).toBe("working");
  });

  it("returns branch before summary when no issue title exists", () => {
    const session = makeSession({
      summary: "You are working on Linear ticket INT-1327: Refactor session manager",
      summaryIsFallback: true,
      issueTitle: null,
      branch: "feat/INT-1327",
    });
    expect(getSessionTitle(session)).toBe("INT 1327");
  });

  it("returns quality summary when neither issue title nor branch exists", () => {
    const session = makeSession({
      summary: "Investigating flaky PR enrichment",
      summaryIsFallback: false,
      issueTitle: null,
      branch: null,
    });
    expect(getSessionTitle(session)).toBe("Investigating flaky PR enrichment");
  });

  it("uses pinnedSummary from metadata before live summary when no branch or issue title", () => {
    const session = makeSession({
      summary: "Drifting live summary from latest agent output",
      summaryIsFallback: false,
      issueTitle: null,
      branch: null,
      metadata: { pinnedSummary: "Stable pinned title" },
    });
    expect(getSessionTitle(session)).toBe("Stable pinned title");
  });

  it("skips pinnedSummary when branch is present (branch takes priority)", () => {
    const session = makeSession({
      summary: "Live summary",
      summaryIsFallback: false,
      issueTitle: null,
      branch: "feat/my-feature",
      metadata: { pinnedSummary: "Pinned summary" },
    });
    expect(getSessionTitle(session)).toBe("My Feature");
  });

  it("falls through to live summary when pinnedSummary is empty", () => {
    const session = makeSession({
      summary: "Live quality summary",
      summaryIsFallback: false,
      issueTitle: null,
      branch: null,
      metadata: { pinnedSummary: "" },
    });
    expect(getSessionTitle(session)).toBe("Live quality summary");
  });
});
