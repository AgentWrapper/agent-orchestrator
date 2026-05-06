import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:child_process — glab CLI calls go through execFileAsync
// ---------------------------------------------------------------------------
const { glabMock } = vi.hoisted(() => ({ glabMock: vi.fn() }));

vi.mock("node:child_process", () => {
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: glabMock,
  });
  return { execFile };
});

import { create, manifest } from "../src/index.js";
import { createActivitySignal, type PRInfo, type Session, type ProjectConfig, type SCMWebhookRequest } from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const pr: PRInfo = {
  number: 42,
  url: "https://gitlab.com/acme/repo/-/merge_requests/42",
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

function mockGlab(result: unknown) {
  glabMock.mockResolvedValueOnce({ stdout: JSON.stringify(result) });
}

function mockGlabError(msg = "Command failed") {
  glabMock.mockRejectedValueOnce(new Error(msg));
}

function makeWebhookRequest(overrides: Partial<SCMWebhookRequest> = {}): SCMWebhookRequest {
  return {
    method: "POST",
    headers: {
      "x-gitlab-event": "Merge Request Hook",
      "x-gitlab-event-uuid": "delivery-1",
    },
    body: JSON.stringify({
      object_kind: "merge_request",
      object_attributes: {
        action: "open",
        iid: 42,
        source_branch: "feat/my-feature",
        updated_at: "2026-03-11T00:00:00Z",
        last_commit: { id: "abc123" },
      },
      project: {
        path_with_namespace: "acme/repo",
      },
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scm-gitlab plugin", () => {
  let scm: ReturnType<typeof create>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    scm = create();
    delete process.env["GITLAB_WEBHOOK_SECRET"];
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("gitlab");
      expect(manifest.slot).toBe("scm");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  // ---- create() ----------------------------------------------------------

  describe("create()", () => {
    it("returns an SCM with correct name", () => {
      expect(scm.name).toBe("gitlab");
    });

    it("accepts host config for self-hosted GitLab", () => {
      const selfHosted = create({ host: "gitlab.internal.corp" });
      expect(selfHosted.name).toBe("gitlab");
    });
  });

  describe("verifyWebhook", () => {
    it("accepts unsigned webhooks when no secret is configured", async () => {
      await expect(scm.verifyWebhook?.(makeWebhookRequest(), project)).resolves.toEqual({
        ok: true,
        deliveryId: "delivery-1",
        eventType: "Merge Request Hook",
      });
    });

    it("verifies token when secret env var is configured", async () => {
      process.env["GITLAB_WEBHOOK_SECRET"] = "topsecret";
      const result = await scm.verifyWebhook?.(
        makeWebhookRequest({
          headers: {
            "x-gitlab-event": "Merge Request Hook",
            "x-gitlab-event-uuid": "delivery-1",
            "x-gitlab-token": "topsecret",
          },
        }),
        {
          ...project,
          scm: { plugin: "gitlab", webhook: { secretEnvVar: "GITLAB_WEBHOOK_SECRET" } },
        },
      );
      expect(result?.ok).toBe(true);
    });

    it("rejects invalid token when secret env var is configured", async () => {
      process.env["GITLAB_WEBHOOK_SECRET"] = "topsecret";
      const result = await scm.verifyWebhook?.(
        makeWebhookRequest({
          headers: {
            "x-gitlab-event": "Merge Request Hook",
            "x-gitlab-event-uuid": "delivery-1",
            "x-gitlab-token": "wrong",
          },
        }),
        {
          ...project,
          scm: { plugin: "gitlab", webhook: { secretEnvVar: "GITLAB_WEBHOOK_SECRET" } },
        },
      );
      expect(result).toEqual(
        expect.objectContaining({ ok: false, reason: "Webhook token verification failed" }),
      );
    });
  });

  describe("parseWebhook", () => {
    it("parses merge request hook events", async () => {
      const event = await scm.parseWebhook?.(makeWebhookRequest(), project);
      expect(event).toEqual(
        expect.objectContaining({
          provider: "gitlab",
          kind: "pull_request",
          action: "open",
          rawEventType: "Merge Request Hook",
          prNumber: 42,
          branch: "feat/my-feature",
          sha: "abc123",
          repository: { owner: "acme", name: "repo" },
        }),
      );
    });

    it("parses push hook events with branch and sha", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          headers: {
            "x-gitlab-event": "Push Hook",
            "x-gitlab-event-uuid": "delivery-2",
          },
          body: JSON.stringify({
            object_kind: "push",
            ref: "refs/heads/feat/my-feature",
            after: "def456",
            event_created_at: "2026-03-11T01:00:00Z",
            project: { path_with_namespace: "acme/repo" },
          }),
        }),
        project,
      );
      expect(event).toEqual(
        expect.objectContaining({
          provider: "gitlab",
          kind: "push",
          branch: "feat/my-feature",
          sha: "def456",
        }),
      );
    });

    it("does not set branch for tag push refs", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          headers: {
            "x-gitlab-event": "Tag Push Hook",
            "x-gitlab-event-uuid": "delivery-3",
          },
          body: JSON.stringify({
            object_kind: "tag_push",
            ref: "refs/tags/v1.0.0",
            after: "def456",
            event_created_at: "2026-03-11T01:00:00Z",
            project: { path_with_namespace: "acme/repo" },
          }),
        }),
        project,
      );
      expect(event).toEqual(
        expect.objectContaining({
          provider: "gitlab",
          kind: "push",
          branch: undefined,
          sha: "def456",
        }),
      );
    });

    it("does not set branch for plain tag push refs", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          headers: {
            "x-gitlab-event": "Tag Push Hook",
            "x-gitlab-event-uuid": "delivery-5",
          },
          body: JSON.stringify({
            object_kind: "tag_push",
            ref: "v1.0.0",
            ref_type: "tag",
            after: "def456",
            event_created_at: "2026-03-11T01:00:00Z",
            project: { path_with_namespace: "acme/repo" },
          }),
        }),
        project,
      );
      expect(event).toEqual(
        expect.objectContaining({
          provider: "gitlab",
          kind: "push",
          branch: undefined,
          sha: "def456",
        }),
      );
    });

    it("does not set branch for tag pipeline refs", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          headers: {
            "x-gitlab-event": "Pipeline Hook",
            "x-gitlab-event-uuid": "delivery-4",
          },
          body: JSON.stringify({
            object_kind: "pipeline",
            ref: "v1.0.0",
            ref_type: "tag",
            checkout_sha: "def456",
            project: { path_with_namespace: "acme/repo" },
            object_attributes: {
              ref: "v1.0.0",
              tag: true,
              updated_at: "2026-03-11T01:00:00Z",
            },
          }),
        }),
        project,
      );
      expect(event).toEqual(
        expect.objectContaining({
          provider: "gitlab",
          kind: "ci",
          branch: undefined,
          sha: "def456",
        }),
      );
    });
  });

  // ---- detectPR ----------------------------------------------------------

  describe("detectPR", () => {
    it("returns PRInfo when an MR exists", async () => {
      mockGlab([
        {
          iid: 42,
          web_url: "https://gitlab.com/acme/repo/-/merge_requests/42",
          title: "feat: add feature",
          source_branch: "feat/my-feature",
          target_branch: "main",
          draft: false,
        },
      ]);

      const result = await scm.detectPR(makeSession(), project);
      expect(result).toEqual({
        number: 42,
        url: "https://gitlab.com/acme/repo/-/merge_requests/42",
        title: "feat: add feature",
        owner: "acme",
        repo: "repo",
        branch: "feat/my-feature",
        baseBranch: "main",
        isDraft: false,
      });
    });

    it("returns null when no MR found", async () => {
      mockGlab([]);
      const result = await scm.detectPR(makeSession(), project);
      expect(result).toBeNull();
    });

    it("returns null when session has no branch", async () => {
      const result = await scm.detectPR(makeSession({ branch: null }), project);
      expect(result).toBeNull();
      expect(glabMock).not.toHaveBeenCalled();
    });

    it("returns null when project has no repo configured", async () => {
      const result = await scm.detectPR(makeSession(), { ...project, repo: undefined });
      expect(result).toBeNull();
      expect(glabMock).not.toHaveBeenCalled();
    });

    it("returns null and warns on glab CLI error", async () => {
      mockGlabError("glab: not found");
      const result = await scm.detectPR(makeSession(), project);
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('detectPR: failed for branch "feat/my-feature"'),
      );
    });

    it("throws on invalid repo format", async () => {
      const badProject = { ...project, repo: "no-slash" };
      await expect(scm.detectPR(makeSession(), badProject)).rejects.toThrow("Invalid repo format");
    });

    it("correctly splits owner for subgroup repos", async () => {
      const subgroupProject = { ...project, repo: "org/sub-group/repo" };
      mockGlab([
        {
          iid: 10,
          web_url: "https://gitlab.com/org/sub-group/repo/-/merge_requests/10",
          title: "feat: subgroup",
          source_branch: "feat/my-feature",
          target_branch: "main",
          draft: false,
        },
      ]);
      const result = await scm.detectPR(makeSession(), subgroupProject);
      expect(result?.owner).toBe("org/sub-group");
      expect(result?.repo).toBe("repo");
    });

    it("handles self-hosted repo with hostname prefix", async () => {
      const selfHostedProject = { ...project, repo: "gitlab.corp.com/org/repo" };
      mockGlab([
        {
          iid: 5,
          web_url: "https://gitlab.corp.com/org/repo/-/merge_requests/5",
          title: "feat: self-hosted",
          source_branch: "feat/my-feature",
          target_branch: "main",
          draft: false,
        },
      ]);
      const result = await scm.detectPR(makeSession(), selfHostedProject);
      expect(result?.owner).toBe("gitlab.corp.com/org");
      expect(result?.repo).toBe("repo");
    });

    it("detects draft MRs", async () => {
      mockGlab([
        {
          iid: 99,
          web_url: "https://gitlab.com/acme/repo/-/merge_requests/99",
          title: "WIP: draft feature",
          source_branch: "feat/my-feature",
          target_branch: "main",
          draft: true,
        },
      ]);
      const result = await scm.detectPR(makeSession(), project);
      expect(result?.isDraft).toBe(true);
    });
  });

  // ---- getPRState --------------------------------------------------------

  describe("getPRState", () => {
    it('returns "open" for opened MR', async () => {
      mockGlab({ state: "opened" });
      expect(await scm.getPRState(pr)).toBe("open");
    });

    it('returns "merged" for merged MR', async () => {
      mockGlab({ state: "merged" });
      expect(await scm.getPRState(pr)).toBe("merged");
    });

    it('returns "closed" for closed MR', async () => {
      mockGlab({ state: "closed" });
      expect(await scm.getPRState(pr)).toBe("closed");
    });

    it("handles uppercase state strings", async () => {
      mockGlab({ state: "Merged" });
      expect(await scm.getPRState(pr)).toBe("merged");
    });
  });

  // ---- getPRSummary ------------------------------------------------------

  describe("getPRSummary", () => {
    it("returns summary with zero additions/deletions", async () => {
      mockGlab({ state: "opened", title: "My MR" });
      const summary = await scm.getPRSummary!(pr);
      expect(summary).toEqual({
        state: "open",
        title: "My MR",
        additions: 0,
        deletions: 0,
      });
    });
  });

  // ---- mergePR -----------------------------------------------------------

  describe("mergePR", () => {
    it("uses --squash by default", async () => {
      glabMock.mockResolvedValueOnce({ stdout: "" });
      await scm.mergePR(pr);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        ["mr", "merge", "42", "--repo", "acme/repo", "--squash", "-d", "-y"],
        expect.any(Object),
      );
    });

    it("uses --rebase when specified", async () => {
      glabMock.mockResolvedValueOnce({ stdout: "" });
      await scm.mergePR(pr, "rebase");
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        expect.arrayContaining(["--rebase"]),
        expect.any(Object),
      );
    });

    it("omits --squash and --rebase for merge method", async () => {
      glabMock.mockResolvedValueOnce({ stdout: "" });
      await scm.mergePR(pr, "merge");
      const args = glabMock.mock.calls[0][1] as string[];
      expect(args).not.toContain("--squash");
      expect(args).not.toContain("--rebase");
    });
  });

  // ---- closePR -----------------------------------------------------------

  describe("closePR", () => {
    it("calls glab mr close", async () => {
      glabMock.mockResolvedValueOnce({ stdout: "" });
      await scm.closePR(pr);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        ["mr", "close", "42", "--repo", "acme/repo"],
        expect.any(Object),
      );
    });
  });

  // ---- getCIChecks -------------------------------------------------------

  describe("getCIChecks", () => {
    it("maps GitLab job statuses correctly", async () => {
      mockGlab([{ id: 100 }]);
      mockGlab([
        {
          name: "build",
          status: "success",
          web_url: "https://ci/1",
          started_at: "2025-01-01T00:00:00Z",
          finished_at: "2025-01-01T00:05:00Z",
        },
        { name: "lint", status: "failed", web_url: "", started_at: null, finished_at: null },
        { name: "deploy", status: "pending", web_url: "", started_at: null, finished_at: null },
        { name: "e2e", status: "running", web_url: "", started_at: null, finished_at: null },
        { name: "optional", status: "skipped", web_url: "", started_at: null, finished_at: null },
        { name: "manual", status: "manual", web_url: "", started_at: null, finished_at: null },
        { name: "canceled", status: "canceled", web_url: "", started_at: null, finished_at: null },
        { name: "created", status: "created", web_url: "", started_at: null, finished_at: null },
        {
          name: "waiting",
          status: "waiting_for_resource",
          web_url: "",
          started_at: null,
          finished_at: null,
        },
        {
          name: "preparing",
          status: "preparing",
          web_url: "",
          started_at: null,
          finished_at: null,
        },
        {
          name: "scheduled",
          status: "scheduled",
          web_url: "",
          started_at: null,
          finished_at: null,
        },
      ]);

      const checks = await scm.getCIChecks(pr);
      expect(checks).toHaveLength(11);
      expect(checks[0].status).toBe("passed");
      expect(checks[0].url).toBe("https://ci/1");
      expect(checks[1].status).toBe("failed");
      expect(checks[2].status).toBe("pending");
      expect(checks[3].status).toBe("running");
      expect(checks[4].status).toBe("skipped");
      expect(checks[5].status).toBe("pending"); // manual
      expect(checks[6].status).toBe("failed"); // canceled
      expect(checks[7].status).toBe("pending"); // created
      expect(checks[8].status).toBe("pending"); // waiting_for_resource
      expect(checks[9].status).toBe("pending"); // preparing
      expect(checks[10].status).toBe("pending"); // scheduled
    });

    it("returns empty array when no pipelines exist", async () => {
      mockGlab([]);
      expect(await scm.getCIChecks(pr)).toEqual([]);
    });

    it("throws on error (fail-closed)", async () => {
      mockGlabError("no pipelines");
      await expect(scm.getCIChecks(pr)).rejects.toThrow("Failed to fetch CI checks");
    });

    it("correctly encodes project ID with subgroups in API path", async () => {
      const subgroupPr = { ...pr, owner: "org/sub-group", repo: "repo" };
      mockGlab([{ id: 100 }]);
      mockGlab([]);
      await scm.getCIChecks(subgroupPr);
      const firstCallArgs = glabMock.mock.calls[0][1] as string[];
      expect(firstCallArgs).toContain(
        "projects/org%2Fsub-group%2Frepo/merge_requests/42/pipelines",
      );
    });

    it("handles unknown job status as failed (fail-closed)", async () => {
      mockGlab([{ id: 100 }]);
      mockGlab([
        { name: "mystery", status: "new_status", web_url: "", started_at: null, finished_at: null },
      ]);
      const checks = await scm.getCIChecks(pr);
      expect(checks[0].status).toBe("failed");
    });

    it("passes --hostname to glab api for self-hosted GitLab", async () => {
      const selfHosted = create({ host: "gitlab.corp.com" });
      mockGlab([{ id: 100 }]);
      mockGlab([]);
      await selfHosted.getCIChecks(pr);
      const firstCallArgs = glabMock.mock.calls[0][1] as string[];
      expect(firstCallArgs[0]).toBe("api");
      expect(firstCallArgs[1]).toBe("--hostname");
      expect(firstCallArgs[2]).toBe("gitlab.corp.com");
    });

    it("strips hostname from project ID and infers --hostname from pr.owner", async () => {
      const selfHostedPr = { ...pr, owner: "gitlab.corp.com/acme", repo: "repo" };
      mockGlab([{ id: 100 }]);
      mockGlab([]);
      await scm.getCIChecks(selfHostedPr);
      const firstCallArgs = glabMock.mock.calls[0][1] as string[];
      expect(firstCallArgs).toContain("--hostname");
      expect(firstCallArgs).toContain("gitlab.corp.com");
      expect(firstCallArgs).toContain("projects/acme%2Frepo/merge_requests/42/pipelines");
    });

    it("does not treat dotted group name as hostname (owner/repo = 2 segments)", async () => {
      const dottedGroupPr = { ...pr, owner: "my.company", repo: "repo" };
      mockGlab([{ id: 100 }]);
      mockGlab([]);
      await scm.getCIChecks(dottedGroupPr);
      const firstCallArgs = glabMock.mock.calls[0][1] as string[];
      expect(firstCallArgs).not.toContain("--hostname");
      expect(firstCallArgs).toContain("projects/my.company%2Frepo/merge_requests/42/pipelines");
    });
  });

  // ---- getCISummary ------------------------------------------------------

  describe("getCISummary", () => {
    it('returns "failing" when any job failed', async () => {
      mockGlab([{ id: 1 }]);
      mockGlab([
        { name: "a", status: "success", web_url: "", started_at: null, finished_at: null },
        { name: "b", status: "failed", web_url: "", started_at: null, finished_at: null },
      ]);
      expect(await scm.getCISummary(pr)).toBe("failing");
    });

    it('returns "pending" when jobs are running', async () => {
      mockGlab([{ id: 1 }]);
      mockGlab([
        { name: "a", status: "success", web_url: "", started_at: null, finished_at: null },
        { name: "b", status: "running", web_url: "", started_at: null, finished_at: null },
      ]);
      expect(await scm.getCISummary(pr)).toBe("pending");
    });

    it('returns "passing" when all jobs passed', async () => {
      mockGlab([{ id: 1 }]);
      mockGlab([
        { name: "a", status: "success", web_url: "", started_at: null, finished_at: null },
        { name: "b", status: "success", web_url: "", started_at: null, finished_at: null },
      ]);
      expect(await scm.getCISummary(pr)).toBe("passing");
    });

    it('returns "none" when no pipelines', async () => {
      mockGlab([]);
      expect(await scm.getCISummary(pr)).toBe("none");
    });

    it('returns "failing" and warns on error (fail-closed)', async () => {
      mockGlabError();
      mockGlabError(); // getPRState also fails
      expect(await scm.getCISummary(pr)).toBe("failing");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("getCISummary: CI check fetch failed for MR !42"),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("getCISummary: PR state fallback also failed for MR !42"),
      );
    });

    it('returns "none" when CI fetch fails but MR is merged', async () => {
      mockGlabError("pipeline error");
      mockGlab({ state: "merged" });
      expect(await scm.getCISummary(pr)).toBe("none");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("getCISummary: CI check fetch failed"),
      );
    });

    it('returns "none" when CI fetch fails but MR is closed', async () => {
      mockGlabError("pipeline error");
      mockGlab({ state: "closed" });
      expect(await scm.getCISummary(pr)).toBe("none");
    });

    it('returns "failing" when both CI fetch and PR state fail', async () => {
      mockGlabError("pipeline error");
      mockGlabError("network error");
      expect(await scm.getCISummary(pr)).toBe("failing");
    });

    it('returns "none" when all jobs are skipped', async () => {
      mockGlab([{ id: 1 }]);
      mockGlab([
        { name: "a", status: "skipped", web_url: "", started_at: null, finished_at: null },
      ]);
      expect(await scm.getCISummary(pr)).toBe("none");
    });
  });

  // ---- getReviews --------------------------------------------------------

  describe("getReviews", () => {
    it("maps approvals to reviews", async () => {
      mockGlab({
        approved_by: [{ user: { username: "alice" } }, { user: { username: "bob" } }],
      });
      mockGlab([]); // discussions

      const reviews = await scm.getReviews(pr);
      expect(reviews).toHaveLength(2);
      expect(reviews[0]).toMatchObject({ author: "alice", state: "approved" });
      expect(reviews[1]).toMatchObject({ author: "bob", state: "approved" });
    });

    it("uses epoch date for approval timestamps (no timestamp available from API)", async () => {
      mockGlab({
        approved_by: [{ user: { username: "alice" } }],
      });
      mockGlab([]); // discussions
      const reviews = await scm.getReviews(pr);
      expect(reviews[0].submittedAt).toEqual(new Date(0));
    });

    it("handles empty approvals", async () => {
      mockGlab({ approved_by: [] });
      mockGlab([]); // discussions
      expect(await scm.getReviews(pr)).toEqual([]);
    });

    it("handles null approved_by", async () => {
      mockGlab({ approved_by: null });
      mockGlab([]); // discussions
      expect(await scm.getReviews(pr)).toEqual([]);
    });

    it('defaults to "unknown" author when user is null', async () => {
      mockGlab({ approved_by: [{ user: null }] });
      mockGlab([]); // discussions
      const reviews = await scm.getReviews(pr);
      expect(reviews[0].author).toBe("unknown");
    });

    it("detects changes_requested from unresolved discussions", async () => {
      mockGlab({ approved_by: [] });
      mockGlab([
        {
          notes: [
            {
              author: { username: "carol" },
              resolvable: true,
              resolved: false,
              created_at: "2025-01-01T00:00:00Z",
            },
          ],
        },
      ]);

      const reviews = await scm.getReviews(pr);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({ author: "carol", state: "changes_requested" });
    });

    it("does not duplicate approved users as changes_requested", async () => {
      mockGlab({ approved_by: [{ user: { username: "alice" } }] });
      mockGlab([
        {
          notes: [
            {
              author: { username: "alice" },
              resolvable: true,
              resolved: false,
              created_at: "2025-01-01T00:00:00Z",
            },
          ],
        },
      ]);

      const reviews = await scm.getReviews(pr);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({ author: "alice", state: "approved" });
    });

    it("returns approvals only and warns when discussions fetch fails", async () => {
      mockGlab({
        approved_by: [{ user: { username: "alice" } }],
      });
      mockGlabError("discussions fetch failed");

      const reviews = await scm.getReviews(pr);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({ author: "alice", state: "approved" });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("getReviews: discussions fetch failed for MR !42"),
      );
    });

    it("filters bot authors from discussions", async () => {
      mockGlab({ approved_by: [] });
      mockGlab([
        {
          notes: [
            {
              author: { username: "gitlab-bot" },
              resolvable: true,
              resolved: false,
              created_at: "2025-01-01T00:00:00Z",
            },
          ],
        },
        {
          notes: [
            {
              author: { username: "project_99_bot" },
              resolvable: true,
              resolved: false,
              created_at: "2025-01-01T00:00:00Z",
            },
          ],
        },
        {
          notes: [
            {
              author: { username: "carol" },
              resolvable: true,
              resolved: false,
              created_at: "2025-01-01T00:00:00Z",
            },
          ],
        },
      ]);

      const reviews = await scm.getReviews(pr);
      expect(reviews).toHaveLength(1);
      expect(reviews[0].author).toBe("carol");
    });

    it("deduplicates same author across multiple discussions", async () => {
      mockGlab({ approved_by: [] });
      mockGlab([
        {
          notes: [
            {
              author: { username: "carol" },
              resolvable: true,
              resolved: false,
              created_at: "2025-01-01T00:00:00Z",
            },
          ],
        },
        {
          notes: [
            {
              author: { username: "carol" },
              resolvable: true,
              resolved: false,
              created_at: "2025-01-02T00:00:00Z",
            },
          ],
        },
      ]);

      const reviews = await scm.getReviews(pr);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({ author: "carol", state: "changes_requested" });
    });
  });

  // ---- getReviewDecision -------------------------------------------------

  describe("getReviewDecision", () => {
    it('returns "approved" when MR is approved', async () => {
      mockGlab({ approved: true, approvals_left: 0 });
      expect(await scm.getReviewDecision(pr)).toBe("approved");
    });

    it('returns "pending" when approvals are left', async () => {
      mockGlab({ approved: false, approvals_left: 2 });
      expect(await scm.getReviewDecision(pr)).toBe("pending");
    });

    it('returns "none" when no approval rules', async () => {
      mockGlab({ approved: false, approvals_left: 0 });
      expect(await scm.getReviewDecision(pr)).toBe("none");
    });

    it("passes --hostname to glab api for self-hosted GitLab", async () => {
      const selfHosted = create({ host: "gitlab.corp.com" });
      mockGlab({ approved: true, approvals_left: 0 });
      await selfHosted.getReviewDecision(pr);
      const args = glabMock.mock.calls[0][1] as string[];
      expect(args[0]).toBe("api");
      expect(args[1]).toBe("--hostname");
      expect(args[2]).toBe("gitlab.corp.com");
    });
  });

  // ---- getPendingComments ------------------------------------------------

  describe("getPendingComments", () => {
    it("returns unresolved non-bot discussion notes", async () => {
      mockGlab([
        {
          id: "d1",
          notes: [
            {
              id: 101,
              author: { username: "alice" },
              body: "Fix this",
              resolvable: true,
              resolved: false,
              position: { new_path: "src/foo.ts", new_line: 10 },
              created_at: "2025-01-01T00:00:00Z",
            },
          ],
        },
        {
          id: "d2",
          notes: [
            {
              id: 102,
              author: { username: "bob" },
              body: "Resolved",
              resolvable: true,
              resolved: true,
              position: { new_path: "src/bar.ts", new_line: 20 },
              created_at: "2025-01-02T00:00:00Z",
            },
          ],
        },
      ]);

      const comments = await scm.getPendingComments(pr);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({ id: "101", author: "alice", isResolved: false });
    });

    it("filters out bot comments", async () => {
      mockGlab([
        {
          id: "d1",
          notes: [
            {
              id: 101,
              author: { username: "alice" },
              body: "Human comment",
              resolvable: true,
              resolved: false,
              created_at: "2025-01-01T00:00:00Z",
            },
          ],
        },
        {
          id: "d2",
          notes: [
            {
              id: 102,
              author: { username: "gitlab-bot" },
              body: "Bot comment",
              resolvable: true,
              resolved: false,
              created_at: "2025-01-01T00:00:00Z",
            },
          ],
        },
        {
          id: "d3",
          notes: [
            {
              id: 103,
              author: { username: "project_42_bot" },
              body: "Project bot",
              resolvable: true,
              resolved: false,
              created_at: "2025-01-01T00:00:00Z",
            },
          ],
        },
      ]);

      const comments = await scm.getPendingComments(pr);
      expect(comments).toHaveLength(1);
      expect(comments[0].author).toBe("alice");
    });

    it("skips non-resolvable discussions", async () => {
      mockGlab([
        {
          id: "d1",
          notes: [
            {
              id: 101,
              author: { username: "alice" },
              body: "System note",
              resolvable: false,
              resolved: false,
              created_at: "2025-01-01T00:00:00Z",
            },
          ],
        },
      ]);

      const comments = await scm.getPendingComments(pr);
      expect(comments).toHaveLength(0);
    });

    it("throws on error (fail-closed)", async () => {
      mockGlabError("API rate limit");
      await expect(scm.getPendingComments(pr)).rejects.toThrow("API rate limit");
    });
  });

  // ---- getMergeability ---------------------------------------------------

  describe("getMergeability", () => {
    it("returns clean result for merged MRs", async () => {
      mockGlab({ state: "merged", draft: false }); // mr view
      const result = await scm.getMergeability(pr);
      expect(result).toEqual({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      });
      expect(glabMock).toHaveBeenCalledTimes(1);
    });

    it("returns not mergeable for closed MRs", async () => {
      mockGlab({ state: "closed", draft: false }); // mr view
      const result = await scm.getMergeability(pr);
      expect(result).toEqual({
        mergeable: false,
        ciPassing: false,
        approved: false,
        noConflicts: true,
        blockers: ["MR is closed"],
      });
      expect(glabMock).toHaveBeenCalledTimes(1);
    });

    it("returns mergeable when everything is clear", async () => {
      mockGlab({ state: "opened", draft: false }); // mr view
      mockGlab({
        merge_status: "can_be_merged",
        has_conflicts: false,
        blocking_discussions_resolved: true,
      }); // API MR detail
      mockGlab([]); // getCIChecks: pipelines (none)
      mockGlab({ approved: true, approvals_left: 0 }); // getReviewDecision

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
      mockGlab({ state: "opened", draft: false }); // mr view
      mockGlab({
        merge_status: "can_be_merged",
        has_conflicts: false,
        blocking_discussions_resolved: true,
      }); // API
      mockGlab([{ id: 1 }]); // pipelines
      mockGlab([
        { name: "build", status: "failed", web_url: "", started_at: null, finished_at: null },
      ]); // jobs
      mockGlab({ approved: true, approvals_left: 0 }); // approvals

      const result = await scm.getMergeability(pr);
      expect(result.ciPassing).toBe(false);
      expect(result.mergeable).toBe(false);
      expect(result.blockers).toContain("CI is failing");
    });

    it("reports merge conflicts as blockers", async () => {
      mockGlab({ state: "opened", draft: false }); // mr view
      mockGlab({
        merge_status: "cannot_be_merged",
        has_conflicts: true,
        blocking_discussions_resolved: true,
      }); // API
      mockGlab([]); // no pipelines
      mockGlab({ approved: true, approvals_left: 0 }); // approvals

      const result = await scm.getMergeability(pr);
      expect(result.noConflicts).toBe(false);
      expect(result.blockers).toContain("Merge conflicts");
    });

    it("reports cannot_be_merged without conflicts as blocker", async () => {
      mockGlab({ state: "opened", draft: false }); // mr view
      mockGlab({
        merge_status: "cannot_be_merged",
        has_conflicts: false,
        blocking_discussions_resolved: true,
      }); // API
      mockGlab([]); // no pipelines
      mockGlab({ approved: true, approvals_left: 0 }); // approvals

      const result = await scm.getMergeability(pr);
      expect(result.blockers).toContain("Merge status: cannot be merged");
      expect(result.noConflicts).toBe(true);
    });

    it("reports checking merge status as blocker", async () => {
      mockGlab({ state: "opened", draft: false }); // mr view
      mockGlab({
        merge_status: "checking",
        has_conflicts: false,
        blocking_discussions_resolved: true,
      }); // API
      mockGlab([]); // no pipelines
      mockGlab({ approved: true, approvals_left: 0 }); // approvals

      const result = await scm.getMergeability(pr);
      expect(result.blockers).toContain("Merge status unknown (GitLab is computing)");
    });

    it("reports unresolved discussions as blockers", async () => {
      mockGlab({ state: "opened", draft: false }); // mr view
      mockGlab({
        merge_status: "can_be_merged",
        has_conflicts: false,
        blocking_discussions_resolved: false,
      }); // API
      mockGlab([]); // no pipelines
      mockGlab({ approved: true, approvals_left: 0 }); // approvals

      const result = await scm.getMergeability(pr);
      expect(result.blockers).toContain("Unresolved discussions blocking merge");
    });

    it("reports draft status as blocker", async () => {
      mockGlab({ state: "opened", draft: true }); // mr view
      mockGlab({
        merge_status: "can_be_merged",
        has_conflicts: false,
        blocking_discussions_resolved: true,
      }); // API
      mockGlab([]); // no pipelines
      mockGlab({ approved: true, approvals_left: 0 }); // approvals

      const result = await scm.getMergeability(pr);
      expect(result.blockers).toContain("MR is still a draft");
    });

    it("reports approval required as blocker", async () => {
      mockGlab({ state: "opened", draft: false }); // mr view
      mockGlab({
        merge_status: "can_be_merged",
        has_conflicts: false,
        blocking_discussions_resolved: true,
      }); // API
      mockGlab([]); // no pipelines
      mockGlab({ approved: false, approvals_left: 2 }); // approvals

      const result = await scm.getMergeability(pr);
      expect(result.approved).toBe(false);
      expect(result.blockers).toContain("Approval required");
    });
  });
});
