import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:child_process — gh CLI calls go through execFileAsync = promisify(execFile)
// vi.hoisted ensures the mock fn is available when vi.mock factory runs (hoisted above imports)
// ---------------------------------------------------------------------------
const { ghMock } = vi.hoisted(() => ({ ghMock: vi.fn() }));

vi.mock("node:child_process", () => {
  // Attach the custom promisify symbol so `promisify(execFile)` returns ghMock
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: ghMock,
  });
  return { execFile };
});

import { create, manifest } from "../src/index.js";
import { _clearProcessCacheForTests, createActivitySignal, type PreflightContext, type PRInfo, type SCMWebhookRequest, type Session, type ProjectConfig } from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const pr: PRInfo = {
  number: 42,
  url: "https://github.com/acme/repo/pull/42",
  title: "feat: add feature",
  owner: "acme",
  repo: "repo",
  branch: "feat/my-feature",
  baseBranch: "main",
  isDraft: false,
};

const project: ProjectConfig = {
  name: "test",
  repo: "acme/repo",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
};

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test",
    status: "working",
    activity: "active",
    activitySignal: createActivitySignal("valid", {
      activity: "active",
      timestamp: new Date(),
      source: "native",
    }),
    branch: "feat/my-feature",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/repo",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function mockGh(result: unknown) {
  ghMock.mockResolvedValueOnce({ stdout: JSON.stringify(result) });
}

function mockGhError(msg = "Command failed") {
  ghMock.mockRejectedValueOnce(new Error(msg));
}

function makeWebhookRequest(overrides: Partial<SCMWebhookRequest> = {}): SCMWebhookRequest {
  return {
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-1",
    },
    body: JSON.stringify({
      action: "opened",
      repository: { owner: { login: "acme" }, name: "repo" },
      pull_request: {
        number: 42,
        updated_at: "2026-03-10T12:00:00Z",
        head: { ref: "feat/my-feature", sha: "abc123" },
      },
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scm-github plugin", () => {
  let scm: ReturnType<typeof create>;

  beforeEach(() => {
    vi.clearAllMocks();
    scm = create();
    delete process.env["GITHUB_WEBHOOK_SECRET"];
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("github");
      expect(manifest.slot).toBe("scm");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  // ---- create() ----------------------------------------------------------

  describe("create()", () => {
    it("returns an SCM with correct name", () => {
      expect(scm.name).toBe("github");
    });
  });

  describe("verifyWebhook", () => {
    it("accepts unsigned webhooks when no secret is configured", async () => {
      await expect(scm.verifyWebhook?.(makeWebhookRequest(), project)).resolves.toEqual({
        ok: true,
        deliveryId: "delivery-1",
        eventType: "pull_request",
      });
    });

    it("verifies a valid HMAC signature", async () => {
      process.env["GITHUB_WEBHOOK_SECRET"] = "topsecret";
      const body = makeWebhookRequest().body;
      const signature = await import("node:crypto").then(
        ({ createHmac }) =>
          `sha256=${createHmac("sha256", "topsecret").update(body).digest("hex")}`,
      );

      const result = await scm.verifyWebhook?.(
        makeWebhookRequest({
          headers: {
            "x-github-event": "pull_request",
            "x-github-delivery": "delivery-1",
            "x-hub-signature-256": signature,
          },
        }),
        {
          ...project,
          scm: { plugin: "github", webhook: { secretEnvVar: "GITHUB_WEBHOOK_SECRET" } },
        },
      );

      expect(result?.ok).toBe(true);
    });

    it("rejects an invalid HMAC signature", async () => {
      process.env["GITHUB_WEBHOOK_SECRET"] = "topsecret";

      const result = await scm.verifyWebhook?.(
        makeWebhookRequest({
          headers: {
            "x-github-event": "pull_request",
            "x-github-delivery": "delivery-1",
            "x-hub-signature-256": "sha256=deadbeef",
          },
        }),
        {
          ...project,
          scm: { plugin: "github", webhook: { secretEnvVar: "GITHUB_WEBHOOK_SECRET" } },
        },
      );

      expect(result).toEqual(
        expect.objectContaining({ ok: false, reason: "Webhook signature verification failed" }),
      );
    });
  });

  describe("parseWebhook", () => {
    it("parses pull_request events", async () => {
      const event = await scm.parseWebhook?.(makeWebhookRequest(), project);
      expect(event).toEqual(
        expect.objectContaining({
          provider: "github",
          kind: "pull_request",
          action: "opened",
          prNumber: 42,
          branch: "feat/my-feature",
          sha: "abc123",
        }),
      );
    });

    it("omits repository when owner.login is not a string", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          body: JSON.stringify({
            action: "opened",
            repository: { owner: { login: 123 }, name: "repo" },
            pull_request: {
              number: 42,
              updated_at: "2026-03-10T12:00:00Z",
              head: { ref: "feat/my-feature", sha: "abc123" },
            },
          }),
        }),
        project,
      );

      expect(event).toEqual(
        expect.objectContaining({ kind: "pull_request", repository: undefined }),
      );
    });

    it("parses issue_comment events on pull requests as comment events", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          headers: { "x-github-event": "issue_comment" },
          body: JSON.stringify({
            action: "created",
            repository: { owner: { login: "acme" }, name: "repo" },
            issue: { number: 42, pull_request: { url: "https://api.github.com/..." } },
            comment: { updated_at: "2026-03-10T12:00:00Z" },
          }),
        }),
        project,
      );

      expect(event).toEqual(
        expect.objectContaining({ provider: "github", kind: "comment", prNumber: 42 }),
      );
    });

    it("falls back to comment.created_at for issue_comment timestamps", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          headers: { "x-github-event": "issue_comment" },
          body: JSON.stringify({
            action: "created",
            repository: { owner: { login: "acme" }, name: "repo" },
            issue: { number: 42, pull_request: { url: "https://api.github.com/..." } },
            comment: { created_at: "2026-03-10T12:00:00Z" },
          }),
        }),
        project,
      );

      expect(event).toEqual(
        expect.objectContaining({ provider: "github", kind: "comment", prNumber: 42 }),
      );
      expect(event?.timestamp?.toISOString()).toBe("2026-03-10T12:00:00.000Z");
    });

    it("parses pull_request_review_comment timestamp from comment payload", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          headers: { "x-github-event": "pull_request_review_comment" },
          body: JSON.stringify({
            action: "created",
            repository: { owner: { login: "acme" }, name: "repo" },
            number: 42,
            pull_request: {
              number: 42,
              head: { ref: "feat/my-feature", sha: "abc123" },
            },
            comment: { created_at: "2026-03-10T12:00:00Z" },
          }),
        }),
        project,
      );

      expect(event).toEqual(
        expect.objectContaining({
          provider: "github",
          kind: "comment",
          prNumber: 42,
        }),
      );
      expect(event?.timestamp?.toISOString()).toBe("2026-03-10T12:00:00.000Z");
    });

    it("parses status events with branch info", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          headers: { "x-github-event": "status" },
          body: JSON.stringify({
            state: "failure",
            repository: { owner: { login: "acme" }, name: "repo" },
            sha: "def456",
            branches: [{ name: "feat/my-feature" }],
            updated_at: "2026-03-10T12:00:00Z",
          }),
        }),
        project,
      );

      expect(event).toEqual(
        expect.objectContaining({
          provider: "github",
          kind: "ci",
          action: "failure",
          branch: "feat/my-feature",
          sha: "def456",
        }),
      );
    });

    it("parses check_run events using check_suite.head_branch", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          headers: { "x-github-event": "check_run" },
          body: JSON.stringify({
            action: "completed",
            repository: { owner: { login: "acme" }, name: "repo" },
            check_run: {
              head_sha: "def456",
              updated_at: "2026-03-10T12:00:00Z",
              pull_requests: [{ number: 42 }],
              check_suite: { head_branch: "feat/my-feature" },
            },
          }),
        }),
        project,
      );

      expect(event).toEqual(
        expect.objectContaining({
          provider: "github",
          kind: "ci",
          branch: "feat/my-feature",
          sha: "def456",
          prNumber: 42,
        }),
      );
    });

    it("parses push events with branch and sha", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          headers: { "x-github-event": "push" },
          body: JSON.stringify({
            ref: "refs/heads/feat/my-feature",
            after: "abcde12345",
            repository: { owner: { login: "acme" }, name: "repo" },
            head_commit: { timestamp: "2026-03-10T12:01:00Z" },
          }),
        }),
        project,
      );

      expect(event).toEqual(
        expect.objectContaining({
          provider: "github",
          kind: "push",
          branch: "feat/my-feature",
          sha: "abcde12345",
        }),
      );
      expect(event?.timestamp?.toISOString()).toBe("2026-03-10T12:01:00.000Z");
    });

    it("does not set branch for tag push refs", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          headers: { "x-github-event": "push" },
          body: JSON.stringify({
            ref: "refs/tags/v1.0.0",
            after: "abcde12345",
            repository: { owner: { login: "acme" }, name: "repo" },
            head_commit: { timestamp: "2026-03-10T12:01:00Z" },
          }),
        }),
        project,
      );

      expect(event).toEqual(
        expect.objectContaining({
          provider: "github",
          kind: "push",
          branch: undefined,
          sha: "abcde12345",
        }),
      );
    });
  });

  // ---- detectPR ----------------------------------------------------------

  describe("detectPR", () => {
    it("returns PRInfo when a PR exists", async () => {
      mockGh([
        {
          number: 42,
          url: "https://github.com/acme/repo/pull/42",
          title: "feat: add feature",
          headRefName: "feat/my-feature",
          baseRefName: "main",
          isDraft: false,
        },
      ]);

      const result = await scm.detectPR(makeSession(), project);
      expect(result).toEqual({
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        title: "feat: add feature",
        owner: "acme",
        repo: "repo",
        branch: "feat/my-feature",
        baseBranch: "main",
        isDraft: false,
      });
    });

    it("returns null when no PR found", async () => {
      mockGh([]);
      const result = await scm.detectPR(makeSession(), project);
      expect(result).toBeNull();
    });

    it("returns null when session has no branch", async () => {
      const result = await scm.detectPR(makeSession({ branch: null }), project);
      expect(result).toBeNull();
      expect(ghMock).not.toHaveBeenCalled();
    });

    it("returns null when project has no repo configured", async () => {
      const result = await scm.detectPR(makeSession(), { ...project, repo: undefined });
      expect(result).toBeNull();
      expect(ghMock).not.toHaveBeenCalled();
    });

    it("returns null on gh CLI error", async () => {
      mockGhError("gh: not found");
      const result = await scm.detectPR(makeSession(), project);
      expect(result).toBeNull();
    });

    it("throws on invalid repo format", async () => {
      const badProject = { ...project, repo: "no-slash" };
      await expect(scm.detectPR(makeSession(), badProject)).rejects.toThrow("Invalid repo format");
    });

    it("rejects repo strings with extra path segments", async () => {
      const badProject = { ...project, repo: "acme/repo/extra" };
      await expect(scm.detectPR(makeSession(), badProject)).rejects.toThrow("Invalid repo format");
    });

    it("detects draft PRs", async () => {
      mockGh([
        {
          number: 99,
          url: "https://github.com/acme/repo/pull/99",
          title: "WIP: draft feature",
          headRefName: "feat/my-feature",
          baseRefName: "main",
          isDraft: true,
        },
      ]);
      const result = await scm.detectPR(makeSession(), project);
      expect(result?.isDraft).toBe(true);
    });

    it("resolves PR by reference", async () => {
      mockGh({
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        title: "feat: add feature",
        headRefName: "feat/my-feature",
        baseRefName: "main",
        isDraft: false,
      });

      const result = await scm.resolvePR?.("42", project);
      expect(result).toEqual(pr);
    });

    it("assigns PR to current user", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await scm.assignPRToCurrentUser?.(pr);
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        ["pr", "edit", "42", "--repo", "acme/repo", "--add-assignee", "@me"],
        expect.any(Object),
      );
    });

    it("checks out PR when workspace is clean and branch differs", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "main\n" });
      ghMock.mockResolvedValueOnce({ stdout: "" });
      ghMock.mockResolvedValueOnce({ stdout: "" });

      const changed = await scm.checkoutPR?.(pr, "/tmp/repo");
      expect(changed).toBe(true);
    });
  });

  // ---- getPRState --------------------------------------------------------

  describe("getPRState", () => {
    it('returns "open" for open PR', async () => {
      mockGh({ state: "OPEN" });
      expect(await scm.getPRState(pr)).toBe("open");
    });

    it('returns "merged" for merged PR', async () => {
      mockGh({ state: "MERGED" });
      expect(await scm.getPRState(pr)).toBe("merged");
    });

    it('returns "closed" for closed PR', async () => {
      mockGh({ state: "CLOSED" });
      expect(await scm.getPRState(pr)).toBe("closed");
    });

    it("handles lowercase state strings", async () => {
      mockGh({ state: "merged" });
      expect(await scm.getPRState(pr)).toBe("merged");
    });
  });

  // ---- mergePR -----------------------------------------------------------

  describe("mergePR", () => {
    it("uses --squash by default", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await scm.mergePR(pr);
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        ["pr", "merge", "42", "--repo", "acme/repo", "--squash", "--delete-branch"],
        expect.any(Object),
      );
    });

    it("uses --merge when specified", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await scm.mergePR(pr, "merge");
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        expect.arrayContaining(["--merge"]),
        expect.any(Object),
      );
    });

    it("uses --rebase when specified", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await scm.mergePR(pr, "rebase");
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        expect.arrayContaining(["--rebase"]),
        expect.any(Object),
      );
    });
  });

  // ---- closePR -----------------------------------------------------------

  describe("closePR", () => {
    it("calls gh pr close", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await scm.closePR(pr);
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        ["pr", "close", "42", "--repo", "acme/repo"],
        expect.any(Object),
      );
    });
  });

  // ---- getCIChecks -------------------------------------------------------

  describe("getCIChecks", () => {
    it("maps various check states correctly", async () => {
      mockGh([
        {
          name: "build",
          state: "SUCCESS",
          link: "https://ci/1",
          startedAt: "2025-01-01T00:00:00Z",
          completedAt: "2025-01-01T00:05:00Z",
        },
        { name: "lint", state: "FAILURE", link: "", startedAt: "", completedAt: "" },
        { name: "deploy", state: "PENDING", link: "", startedAt: "", completedAt: "" },
        { name: "e2e", state: "IN_PROGRESS", link: "", startedAt: "", completedAt: "" },
        { name: "optional", state: "SKIPPED", link: "", startedAt: "", completedAt: "" },
        { name: "neutral", state: "NEUTRAL", link: "", startedAt: "", completedAt: "" },
        { name: "timeout", state: "TIMED_OUT", link: "", startedAt: "", completedAt: "" },
        { name: "queued", state: "QUEUED", link: "", startedAt: "", completedAt: "" },
        { name: "cancelled", state: "CANCELLED", link: "", startedAt: "", completedAt: "" },
        { name: "action_req", state: "ACTION_REQUIRED", link: "", startedAt: "", completedAt: "" },
      ]);

      const checks = await scm.getCIChecks(pr);
      expect(checks).toHaveLength(10);
      expect(checks[0].status).toBe("passed");
      expect(checks[0].url).toBe("https://ci/1");
      expect(checks[1].status).toBe("failed");
      expect(checks[2].status).toBe("pending");
      expect(checks[3].status).toBe("running");
      expect(checks[4].status).toBe("skipped");
      expect(checks[5].status).toBe("skipped");
      expect(checks[6].status).toBe("failed");
      expect(checks[7].status).toBe("pending");
      expect(checks[8].status).toBe("failed"); // CANCELLED
      expect(checks[9].status).toBe("failed"); // ACTION_REQUIRED
    });

    it("throws on error (fail-closed)", async () => {
      mockGhError("no checks");
      await expect(scm.getCIChecks(pr)).rejects.toThrow("Failed to fetch CI checks");
    });

    it("returns empty array for PR with no checks", async () => {
      mockGh([]);
      expect(await scm.getCIChecks(pr)).toEqual([]);
    });

    it("handles missing optional fields gracefully", async () => {
      mockGh([{ name: "test", state: "SUCCESS" }]);
      const checks = await scm.getCIChecks(pr);
      expect(checks[0].url).toBeUndefined();
      expect(checks[0].startedAt).toBeUndefined();
      expect(checks[0].completedAt).toBeUndefined();
    });

    it("falls back to statusCheckRollup when pr checks json is unsupported", async () => {
      mockGhError("gh pr checks failed: unknown json field 'state'");
      mockGh({
        statusCheckRollup: [
          {
            name: "build",
            state: "SUCCESS",
            detailsUrl: "https://ci/1",
            startedAt: "2025-01-01T00:00:00Z",
            completedAt: "2025-01-01T00:01:00Z",
          },
        ],
      });

      const checks = await scm.getCIChecks(pr);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ name: "build", status: "passed" });
    });
  });

  // ---- getCISummary ------------------------------------------------------

  describe("getCISummary", () => {
    it('returns "failing" when any check failed', async () => {
      mockGh([
        { name: "a", state: "SUCCESS" },
        { name: "b", state: "FAILURE" },
      ]);
      expect(await scm.getCISummary(pr)).toBe("failing");
    });

    it('returns "pending" when checks are running', async () => {
      mockGh([
        { name: "a", state: "SUCCESS" },
        { name: "b", state: "IN_PROGRESS" },
      ]);
      expect(await scm.getCISummary(pr)).toBe("pending");
    });

    it('returns "passing" when all checks passed', async () => {
      mockGh([
        { name: "a", state: "SUCCESS" },
        { name: "b", state: "SUCCESS" },
      ]);
      expect(await scm.getCISummary(pr)).toBe("passing");
    });

    it('returns "none" when no checks', async () => {
      mockGh([]);
      expect(await scm.getCISummary(pr)).toBe("none");
    });

    it('returns "failing" on error (fail-closed)', async () => {
      mockGhError();
      expect(await scm.getCISummary(pr)).toBe("failing");
    });

    it('returns "none" when all checks are skipped', async () => {
      mockGh([
        { name: "a", state: "SKIPPED" },
        { name: "b", state: "NEUTRAL" },
      ]);
      expect(await scm.getCISummary(pr)).toBe("none");
    });
  });

  // ---- getReviews --------------------------------------------------------

  describe("getReviews", () => {
    it("maps review states correctly", async () => {
      mockGh({
        reviews: [
          {
            author: { login: "alice" },
            state: "APPROVED",
            body: "LGTM",
            submittedAt: "2025-01-01T00:00:00Z",
          },
          {
            author: { login: "bob" },
            state: "CHANGES_REQUESTED",
            body: "Fix this",
            submittedAt: "2025-01-02T00:00:00Z",
          },
          {
            author: { login: "charlie" },
            state: "COMMENTED",
            body: "",
            submittedAt: "2025-01-03T00:00:00Z",
          },
          {
            author: { login: "eve" },
            state: "DISMISSED",
            body: "",
            submittedAt: "2025-01-04T00:00:00Z",
          },
          { author: { login: "frank" }, state: "PENDING", body: "", submittedAt: null },
        ],
      });

      const reviews = await scm.getReviews(pr);
      expect(reviews).toHaveLength(5);
      expect(reviews[0]).toMatchObject({ author: "alice", state: "approved" });
      expect(reviews[1]).toMatchObject({ author: "bob", state: "changes_requested" });
      expect(reviews[2]).toMatchObject({ author: "charlie", state: "commented" });
      expect(reviews[3]).toMatchObject({ author: "eve", state: "dismissed" });
      expect(reviews[4]).toMatchObject({ author: "frank", state: "pending" });
    });

    it("handles empty reviews", async () => {
      mockGh({ reviews: [] });
      expect(await scm.getReviews(pr)).toEqual([]);
    });

    it('defaults to "unknown" author when missing', async () => {
      mockGh({
        reviews: [
          { author: null, state: "APPROVED", body: "", submittedAt: "2025-01-01T00:00:00Z" },
        ],
      });
      const reviews = await scm.getReviews(pr);
      expect(reviews[0].author).toBe("unknown");
    });
  });

  // ---- getReviewDecision -------------------------------------------------

  describe("getReviewDecision", () => {
    it.each([
      ["APPROVED", "approved"],
      ["CHANGES_REQUESTED", "changes_requested"],
      ["REVIEW_REQUIRED", "pending"],
    ] as const)('maps %s to "%s"', async (input, expected) => {
      mockGh({ reviewDecision: input });
      expect(await scm.getReviewDecision(pr)).toBe(expected);
    });

    it('returns "none" when reviewDecision is empty', async () => {
      mockGh({ reviewDecision: "" });
      expect(await scm.getReviewDecision(pr)).toBe("none");
    });

    it('returns "none" when reviewDecision is null', async () => {
      mockGh({ reviewDecision: null });
      expect(await scm.getReviewDecision(pr)).toBe("none");
    });
  });

  // ---- getPendingComments ------------------------------------------------

  describe("getPendingComments", () => {
    function makeGraphQLThreads(
      threads: Array<{
        isResolved: boolean;
        id: string;
        author: string | null;
        body: string;
        path: string | null;
        line: number | null;
        url: string;
        createdAt: string;
      }>,
    ) {
      return {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: threads.map((t) => ({
                  isResolved: t.isResolved,
                  comments: {
                    nodes: [
                      {
                        id: t.id,
                        author: t.author ? { login: t.author } : null,
                        body: t.body,
                        path: t.path,
                        line: t.line,
                        url: t.url,
                        createdAt: t.createdAt,
                      },
                    ],
                  },
                })),
              },
            },
          },
        },
      };
    }

    it("returns only unresolved non-bot comments from GraphQL", async () => {
      mockGh(
        makeGraphQLThreads([
          {
            isResolved: false,
            id: "C1",
            author: "alice",
            body: "Fix line 10",
            path: "src/foo.ts",
            line: 10,
            url: "https://github.com/c/1",
            createdAt: "2025-01-01T00:00:00Z",
          },
          {
            isResolved: true,
            id: "C2",
            author: "bob",
            body: "Resolved one",
            path: "src/bar.ts",
            line: 20,
            url: "https://github.com/c/2",
            createdAt: "2025-01-02T00:00:00Z",
          },
        ]),
      );

      const comments = await scm.getPendingComments(pr);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({ id: "C1", author: "alice", isResolved: false });
    });

    it("filters out bot comments", async () => {
      mockGh(
        makeGraphQLThreads([
          {
            isResolved: false,
            id: "C1",
            author: "alice",
            body: "Fix this",
            path: "a.ts",
            line: 1,
            url: "u",
            createdAt: "2025-01-01T00:00:00Z",
          },
          {
            isResolved: false,
            id: "C2",
            author: "cursor[bot]",
            body: "Bot says",
            path: "a.ts",
            line: 2,
            url: "u",
            createdAt: "2025-01-01T00:00:00Z",
          },
          {
            isResolved: false,
            id: "C3",
            author: "codecov[bot]",
            body: "Coverage",
            path: "a.ts",
            line: 3,
            url: "u",
            createdAt: "2025-01-01T00:00:00Z",
          },
        ]),
      );

      const comments = await scm.getPendingComments(pr);
      expect(comments).toHaveLength(1);
      expect(comments[0].author).toBe("alice");
    });

    it("throws on error", async () => {
      mockGhError("API rate limit");
      await expect(scm.getPendingComments(pr)).rejects.toThrow("Failed to fetch pending comments");
    });

    it("handles null path and line", async () => {
      mockGh(
        makeGraphQLThreads([
          {
            isResolved: false,
            id: "C1",
            author: "alice",
            body: "General comment",
            path: null,
            line: null,
            url: "u",
            createdAt: "2025-01-01T00:00:00Z",
          },
        ]),
      );
      const comments = await scm.getPendingComments(pr);
      expect(comments[0].path).toBeUndefined();
      expect(comments[0].line).toBeUndefined();
    });
  });

  // ---- getMergeability ---------------------------------------------------

  describe("getMergeability", () => {
    it("returns clean result for merged PRs without querying mergeable status", async () => {
      // getPRState call
      mockGh({ state: "MERGED" });

      const result = await scm.getMergeability(pr);
      expect(result).toEqual({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      });
      // Should only call gh once (for getPRState), not for mergeable/CI
      expect(ghMock).toHaveBeenCalledTimes(1);
    });

    it("still checks mergeability for closed PRs (not merged)", async () => {
      // getPRState call
      mockGh({ state: "CLOSED" });
      // PR view (closed PRs still get checked)
      mockGh({
        mergeable: "CONFLICTING",
        reviewDecision: "APPROVED",
        mergeStateStatus: "DIRTY",
        isDraft: false,
      });
      // CI checks
      mockGh([]);

      const result = await scm.getMergeability(pr);
      expect(result.noConflicts).toBe(false);
      expect(result.blockers).toContain("Merge conflicts");
      // Closed PRs go through normal checks, unlike merged PRs
    });

    it("returns mergeable when everything is clear", async () => {
      // getPRState call (for open PR)
      mockGh({ state: "OPEN" });
      // PR view
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        isDraft: false,
      });
      // CI checks (called by getCISummary)
      mockGh([{ name: "build", state: "SUCCESS" }]);

      const result = await scm.getMergeability(pr);
      expect(result).toEqual({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      });
    });

    it("reports CI failures as blockers", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        mergeStateStatus: "UNSTABLE",
        isDraft: false,
      });
      mockGh([{ name: "build", state: "FAILURE" }]);

      const result = await scm.getMergeability(pr);
      expect(result.ciPassing).toBe(false);
      expect(result.mergeable).toBe(false);
      expect(result.blockers).toContain("CI is failing");
      expect(result.blockers).toContain("Required checks are failing");
    });

    it("reports UNSTABLE merge state even when CI fetch fails", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        mergeStateStatus: "UNSTABLE",
        isDraft: false,
      });
      mockGhError("rate limited");

      const result = await scm.getMergeability(pr);
      expect(result.ciPassing).toBe(false);
      expect(result.mergeable).toBe(false);
      expect(result.blockers).toContain("CI is failing");
      expect(result.blockers).toContain("Required checks are failing");
    });

    it("reports changes requested as blockers", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "CHANGES_REQUESTED",
        mergeStateStatus: "CLEAN",
        isDraft: false,
      });
      mockGh([]); // no CI checks

      const result = await scm.getMergeability(pr);
      expect(result.approved).toBe(false);
      expect(result.blockers).toContain("Changes requested in review");
    });

    it("reports review required as blocker", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "REVIEW_REQUIRED",
        mergeStateStatus: "BLOCKED",
        isDraft: false,
      });
      mockGh([]);

      const result = await scm.getMergeability(pr);
      expect(result.blockers).toContain("Review required");
    });

    it("reports merge conflicts as blockers", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "CONFLICTING",
        reviewDecision: "APPROVED",
        mergeStateStatus: "DIRTY",
        isDraft: false,
      });
      mockGh([]);

      const result = await scm.getMergeability(pr);
      expect(result.noConflicts).toBe(false);
      expect(result.blockers).toContain("Merge conflicts");
    });

    it("reports UNKNOWN mergeable as noConflicts false", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "UNKNOWN",
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        isDraft: false,
      });
      mockGh([{ name: "build", state: "SUCCESS" }]);

      const result = await scm.getMergeability(pr);
      expect(result.noConflicts).toBe(false);
      expect(result.blockers).toContain("Merge status unknown (GitHub is computing)");
      expect(result.mergeable).toBe(false);
    });

    it("reports draft status as blocker", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        mergeStateStatus: "DRAFT",
        isDraft: true,
      });
      mockGh([{ name: "build", state: "SUCCESS" }]);

      const result = await scm.getMergeability(pr);
      expect(result.blockers).toContain("PR is still a draft");
      expect(result.mergeable).toBe(false);
    });

    it("reports multiple blockers simultaneously", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "CONFLICTING",
        reviewDecision: "CHANGES_REQUESTED",
        mergeStateStatus: "DIRTY",
        isDraft: true,
      });
      mockGh([{ name: "build", state: "FAILURE" }]);

      const result = await scm.getMergeability(pr);
      expect(result.blockers).toHaveLength(4);
      expect(result.mergeable).toBe(false);
    });
  });

  // ---- PR cache (per-method TTLs, write invalidation) -------------------

  describe("PR cache", () => {
    it("getPRState second call within 5s hits cache", async () => {
      mockGh({ state: "OPEN" });
      const first = await scm.getPRState(pr);
      const second = await scm.getPRState(pr);
      expect(first).toBe("open");
      expect(second).toBe("open");
      expect(ghMock).toHaveBeenCalledTimes(1);
    });

    it("getPRState re-fetches after TTL expires (5s)", async () => {
      vi.useFakeTimers();
      try {
        mockGh({ state: "OPEN" });
        await scm.getPRState(pr);
        expect(ghMock).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(5_001);

        mockGh({ state: "MERGED" });
        const fresh = await scm.getPRState(pr);
        expect(fresh).toBe("merged");
        expect(ghMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("getPRState and getPRSummary use separate cache slots", async () => {
      mockGh({ state: "OPEN" });
      mockGh({ state: "OPEN", title: "T", additions: 10, deletions: 5 });

      await scm.getPRState(pr);
      await scm.getPRSummary(pr);
      expect(ghMock).toHaveBeenCalledTimes(2);

      // Both now cached — second round hits cache, no new gh calls
      await scm.getPRState(pr);
      await scm.getPRSummary(pr);
      expect(ghMock).toHaveBeenCalledTimes(2);
    });

    it("getReviews caches independently of getReviewDecision", async () => {
      mockGh({ reviews: [] });
      mockGh({ reviewDecision: "APPROVED" });
      await scm.getReviews(pr);
      await scm.getReviewDecision(pr);
      expect(ghMock).toHaveBeenCalledTimes(2);

      // Cache hits on second round
      await scm.getReviews(pr);
      await scm.getReviewDecision(pr);
      expect(ghMock).toHaveBeenCalledTimes(2);
    });

    it("different PRs cache independently", async () => {
      const otherPR = { ...pr, number: 99 };
      mockGh({ state: "OPEN" });
      mockGh({ state: "MERGED" });
      const a = await scm.getPRState(pr);
      const b = await scm.getPRState(otherPR);
      expect(a).toBe("open");
      expect(b).toBe("merged");
      expect(ghMock).toHaveBeenCalledTimes(2);
    });

    it("mergePR invalidates the PR's cache", async () => {
      mockGh({ state: "OPEN" });
      await scm.getPRState(pr);
      expect(ghMock).toHaveBeenCalledTimes(1);

      ghMock.mockResolvedValueOnce({ stdout: "" }); // gh pr merge
      await scm.mergePR(pr);

      mockGh({ state: "MERGED" });
      const fresh = await scm.getPRState(pr);
      expect(fresh).toBe("merged");
      expect(ghMock).toHaveBeenCalledTimes(3);
    });

    it("closePR invalidates the PR's cache", async () => {
      mockGh({ state: "OPEN" });
      await scm.getPRState(pr);

      ghMock.mockResolvedValueOnce({ stdout: "" }); // gh pr close
      await scm.closePR(pr);

      mockGh({ state: "CLOSED" });
      const fresh = await scm.getPRState(pr);
      expect(fresh).toBe("closed");
      expect(ghMock).toHaveBeenCalledTimes(3);
    });

    it("assignPRToCurrentUser invalidates the PR's cache", async () => {
      mockGh({ reviewDecision: "REVIEW_REQUIRED" });
      await scm.getReviewDecision(pr);

      ghMock.mockResolvedValueOnce({ stdout: "" }); // gh pr edit
      await scm.assignPRToCurrentUser(pr);

      mockGh({ reviewDecision: "REVIEW_REQUIRED" });
      await scm.getReviewDecision(pr);
      expect(ghMock).toHaveBeenCalledTimes(3); // view + edit + view again
    });

    it("invalidating one PR does not affect a different PR's cache", async () => {
      const otherPR = { ...pr, number: 99 };
      mockGh({ state: "OPEN" });
      mockGh({ state: "OPEN" });
      await scm.getPRState(pr);
      await scm.getPRState(otherPR);
      expect(ghMock).toHaveBeenCalledTimes(2);

      ghMock.mockResolvedValueOnce({ stdout: "" });
      await scm.closePR(pr); // wipes pr #42 only

      mockGh({ state: "CLOSED" });
      await scm.getPRState(pr); // re-fetches
      await scm.getPRState(otherPR); // still cached
      expect(ghMock).toHaveBeenCalledTimes(4);
    });

    it("resolvePR caches by reference for 60s", async () => {
      mockGh({
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        title: "Fix",
        headRefName: "feat/x",
        baseRefName: "main",
        isDraft: false,
      });
      const first = await scm.resolvePR("feat/x", project);
      const second = await scm.resolvePR("feat/x", project);
      expect(first).toEqual(second);
      expect(ghMock).toHaveBeenCalledTimes(1);
    });

    it("failures are not cached", async () => {
      ghMock.mockRejectedValueOnce(new Error("boom"));
      await expect(scm.getPRState(pr)).rejects.toThrow();

      mockGh({ state: "OPEN" });
      const fresh = await scm.getPRState(pr);
      expect(fresh).toBe("open");
      expect(ghMock).toHaveBeenCalledTimes(2);
    });

    it("each create() returns an isolated cache", async () => {
      const scmA = create();
      const scmB = create();
      mockGh({ state: "OPEN" });
      await scmA.getPRState(pr);
      mockGh({ state: "MERGED" });
      const fromB = await scmB.getPRState(pr);
      expect(fromB).toBe("merged");
      expect(ghMock).toHaveBeenCalledTimes(2);
    });

    // ---- detectPR (positive-only cache) ----

    it("detectPR caches positive results (PR found)", async () => {
      mockGh([
        {
          number: 42,
          url: "https://github.com/acme/repo/pull/42",
          title: "feat: add feature",
          headRefName: "feat/my-feature",
          baseRefName: "main",
          isDraft: false,
        },
      ]);
      const a = await scm.detectPR(makeSession(), project);
      const b = await scm.detectPR(makeSession(), project);
      expect(a?.number).toBe(42);
      expect(b?.number).toBe(42);
      expect(ghMock).toHaveBeenCalledTimes(1);
    });

    it("detectPR does NOT cache negative results (no PR yet)", async () => {
      mockGh([]);
      mockGh([]);
      const a = await scm.detectPR(makeSession(), project);
      const b = await scm.detectPR(makeSession(), project);
      expect(a).toBeNull();
      expect(b).toBeNull();
      expect(ghMock).toHaveBeenCalledTimes(2);
    });

    it("detectPR transitions null → PR on next call without cache poisoning", async () => {
      mockGh([]); // first call: no PR yet
      const before = await scm.detectPR(makeSession(), project);
      expect(before).toBeNull();

      mockGh([
        {
          number: 7,
          url: "https://github.com/acme/repo/pull/7",
          title: "Just created",
          headRefName: "feat/my-feature",
          baseRefName: "main",
          isDraft: false,
        },
      ]);
      const after = await scm.detectPR(makeSession(), project);
      expect(after?.number).toBe(7);
      expect(ghMock).toHaveBeenCalledTimes(2);
    });

    it("detectPR caches different branches independently", async () => {
      mockGh([
        {
          number: 1,
          url: "u1",
          title: "t1",
          headRefName: "feat/a",
          baseRefName: "main",
          isDraft: false,
        },
      ]);
      mockGh([
        {
          number: 2,
          url: "u2",
          title: "t2",
          headRefName: "feat/b",
          baseRefName: "main",
          isDraft: false,
        },
      ]);
      const a = await scm.detectPR(makeSession({ branch: "feat/a" }), project);
      const b = await scm.detectPR(makeSession({ branch: "feat/b" }), project);
      expect(a?.number).toBe(1);
      expect(b?.number).toBe(2);
      expect(ghMock).toHaveBeenCalledTimes(2);
    });

    it("mergePR invalidates the branch's detectPR entry", async () => {
      mockGh([
        {
          number: 42,
          url: "https://github.com/acme/repo/pull/42",
          title: "feat",
          headRefName: pr.branch,
          baseRefName: "main",
          isDraft: false,
        },
      ]);
      await scm.detectPR(makeSession({ branch: pr.branch }), project);
      expect(ghMock).toHaveBeenCalledTimes(1);

      ghMock.mockResolvedValueOnce({ stdout: "" }); // gh pr merge
      await scm.mergePR(pr);

      // detectPR re-fetches because the merge invalidated the branch entry
      mockGh([]);
      const after = await scm.detectPR(makeSession({ branch: pr.branch }), project);
      expect(after).toBeNull();
      expect(ghMock).toHaveBeenCalledTimes(3);
    });

    // ---- getCIChecks / getMergeability / getPendingComments ----

    it("getCIChecks caches result (5s TTL)", async () => {
      mockGh([{ name: "build", state: "SUCCESS", link: "u", startedAt: "", completedAt: "" }]);
      await scm.getCIChecks(pr);
      await scm.getCIChecks(pr);
      expect(ghMock).toHaveBeenCalledTimes(1);
    });

    it("getMergeability caches the composite result", async () => {
      // First call: getPRState (1) + pr view mergeable (2) + getCISummary→getCIChecks (3)
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        isDraft: false,
      });
      mockGh([{ name: "build", state: "SUCCESS" }]); // getCIChecks
      const first = await scm.getMergeability(pr);
      expect(first.mergeable).toBe(true);

      // Second call within TTL: top-level getMergeability cache hits.
      // No new gh calls because the composite result short-circuits.
      const second = await scm.getMergeability(pr);
      expect(second).toEqual(first);
      expect(ghMock).toHaveBeenCalledTimes(3);
    });

    it("mergePR invalidates getMergeability cache", async () => {
      mockGh({ state: "OPEN" });
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        isDraft: false,
      });
      mockGh([{ name: "build", state: "SUCCESS" }]);
      await scm.getMergeability(pr);
      expect(ghMock).toHaveBeenCalledTimes(3);

      ghMock.mockResolvedValueOnce({ stdout: "" }); // gh pr merge
      await scm.mergePR(pr);

      // After merge: state cached as merged; getMergeability re-derives
      // the merged shortcut result without making more gh calls.
      mockGh({ state: "MERGED" }); // getPRState refetch
      const after = await scm.getMergeability(pr);
      expect(after.mergeable).toBe(true);
      expect(after.blockers).toEqual([]);
    });

    it("getPendingComments caches result", async () => {
      mockGhRaw(
        JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        }),
      );
      await scm.getPendingComments(pr);
      await scm.getPendingComments(pr);
      expect(ghMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("preflight", () => {
    function ctxWith(willClaim: boolean): PreflightContext {
      return { project, intent: { role: "worker", willClaimExistingPR: willClaim } };
    }

    beforeEach(() => {
      _clearProcessCacheForTests();
    });

    it("is a no-op when willClaimExistingPR is false (no gh calls made)", async () => {
      await expect(scm.preflight!(ctxWith(false))).resolves.toBeUndefined();
      expect(ghMock).not.toHaveBeenCalled();
    });

    it("checks gh installed + authenticated when willClaimExistingPR is true", async () => {
      mockGhRaw("gh version 2.40.0");
      mockGhRaw("Logged in to github.com as alice");
      await expect(scm.preflight!(ctxWith(true))).resolves.toBeUndefined();
      expect(ghMock).toHaveBeenCalledTimes(2);
    });

    it("throws 'not installed' when `gh --version` fails", async () => {
      mockGhError("ENOENT");
      const err = (await scm.preflight!(ctxWith(true)).catch((e: unknown) => e)) as Error;
      expect(err.message).toContain("GitHub CLI (gh) is not installed");
    });

    it("throws 'not authenticated' when `gh auth status` fails", async () => {
      mockGhRaw("gh version 2.40.0");
      mockGhError("not logged in");
      const err = (await scm.preflight!(ctxWith(true)).catch((e: unknown) => e)) as Error;
      expect(err.message).toContain("not authenticated");
    });
  });
});

function mockGhRaw(stdout: string) {
  ghMock.mockResolvedValueOnce({ stdout });
}
