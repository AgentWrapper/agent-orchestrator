import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:child_process
// ---------------------------------------------------------------------------
const { ghMock } = vi.hoisted(() => ({ ghMock: vi.fn() }));

vi.mock("node:child_process", () => {
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: ghMock,
  });
  return { execFile };
});

import { create, manifest } from "../src/index.js";
import {
  _clearProcessCacheForTests,
  type PreflightContext,
  type ProjectConfig,
} from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const project: ProjectConfig = {
  name: "test",
  repo: "acme/repo",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
};

function mockGh(result: unknown) {
  ghMock.mockResolvedValueOnce({ stdout: JSON.stringify(result) });
}

function mockGhRaw(stdout: string) {
  ghMock.mockResolvedValueOnce({ stdout });
}

function mockGhError(msg = "Command failed") {
  ghMock.mockRejectedValueOnce(new Error(msg));
}

const sampleIssue = {
  number: 123,
  title: "Fix login bug",
  body: "Users can't log in with SSO",
  url: "https://github.com/acme/repo/issues/123",
  state: "OPEN",
  stateReason: null as string | null,
  labels: [{ name: "bug" }, { name: "priority-high" }],
  assignees: [{ login: "alice" }],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tracker-github plugin", () => {
  let tracker: ReturnType<typeof create>;

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = create();
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("github");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("github");
    });
  });

  // ---- getIssue ----------------------------------------------------------

  describe("getIssue", () => {
    it("returns Issue with correct fields", async () => {
      mockGh(sampleIssue);
      const issue = await tracker.getIssue("123", project);
      expect(issue).toEqual({
        id: "123",
        title: "Fix login bug",
        description: "Users can't log in with SSO",
        url: "https://github.com/acme/repo/issues/123",
        state: "open",
        labels: ["bug", "priority-high"],
        assignee: "alice",
      });
    });

    it("maps CLOSED state to closed", async () => {
      mockGh({ ...sampleIssue, state: "CLOSED", stateReason: "COMPLETED" });
      const issue = await tracker.getIssue("123", project);
      expect(issue.state).toBe("closed");
    });

    it("maps NOT_PLANNED close reason to cancelled", async () => {
      mockGh({ ...sampleIssue, state: "CLOSED", stateReason: "NOT_PLANNED" });
      const issue = await tracker.getIssue("123", project);
      expect(issue.state).toBe("cancelled");
    });

    it("handles missing body gracefully", async () => {
      mockGh({ ...sampleIssue, body: null });
      const issue = await tracker.getIssue("123", project);
      expect(issue.description).toBe("");
    });

    it("handles empty assignees", async () => {
      mockGh({ ...sampleIssue, assignees: [] });
      const issue = await tracker.getIssue("123", project);
      expect(issue.assignee).toBeUndefined();
    });

    it("propagates gh CLI errors", async () => {
      mockGhError("issue not found");
      await expect(tracker.getIssue("999", project)).rejects.toThrow("issue not found");
    });

    it("falls back when gh does not support stateReason field", async () => {
      mockGhError('gh issue view failed: Unknown JSON field "stateReason"');
      mockGh({ ...sampleIssue, stateReason: undefined });

      const issue = await tracker.getIssue("123", project);

      expect(issue.state).toBe("open");
      expect(ghMock).toHaveBeenCalledTimes(2);
      expect(ghMock.mock.calls[0]?.[1]).toEqual(
        expect.arrayContaining([expect.stringContaining("state,stateReason")]),
      );
      expect(ghMock.mock.calls[1]?.[1]).toEqual(
        expect.arrayContaining([expect.stringContaining("state,labels,assignees")]),
      );
    });

    it("falls back on alternative unknown-field phrasing for stateReason", async () => {
      mockGhError("gh issue view failed: invalid field 'stateReason'");
      mockGh({ ...sampleIssue, stateReason: undefined });

      const issue = await tracker.getIssue("123", project);

      expect(issue.state).toBe("open");
      expect(ghMock).toHaveBeenCalledTimes(2);
    });

    it("does not swallow unrelated unknown-field errors", async () => {
      mockGhError('gh issue view failed: Unknown JSON field "milestone"');

      await expect(tracker.getIssue("123", project)).rejects.toThrow(
        'Unknown JSON field "milestone"',
      );
      expect(ghMock).toHaveBeenCalledTimes(1);
    });

    it("throws on malformed JSON response", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "not json{" });
      await expect(tracker.getIssue("123", project)).rejects.toThrow();
    });
  });

  // ---- isCompleted -------------------------------------------------------

  describe("isCompleted", () => {
    it("returns true for CLOSED issues", async () => {
      mockGh({ ...sampleIssue, state: "CLOSED", stateReason: "COMPLETED" });
      expect(await tracker.isCompleted("123", project)).toBe(true);
    });

    it("returns false for OPEN issues", async () => {
      mockGh({ ...sampleIssue, state: "OPEN" });
      expect(await tracker.isCompleted("123", project)).toBe(false);
    });

    it("returns true for cancelled (CLOSED + NOT_PLANNED) issues", async () => {
      mockGh({ ...sampleIssue, state: "CLOSED", stateReason: "NOT_PLANNED" });
      expect(await tracker.isCompleted("123", project)).toBe(true);
    });
  });

  // ---- issue cache -------------------------------------------------------

  describe("issue cache", () => {
    it("second getIssue for same (repo, id) hits cache — no gh call", async () => {
      mockGh(sampleIssue);
      const first = await tracker.getIssue("123", project);
      const second = await tracker.getIssue("123", project);
      expect(first).toEqual(second);
      expect(ghMock).toHaveBeenCalledTimes(1);
    });

    it("isCompleted shares the same cache as getIssue", async () => {
      mockGh(sampleIssue);
      await tracker.getIssue("123", project);
      const done = await tracker.isCompleted("123", project);
      expect(done).toBe(false);
      expect(ghMock).toHaveBeenCalledTimes(1);
    });

    it("different identifiers cache independently", async () => {
      mockGh(sampleIssue);
      mockGh({ ...sampleIssue, number: 456 });
      await tracker.getIssue("123", project);
      await tracker.getIssue("456", project);
      expect(ghMock).toHaveBeenCalledTimes(2);
      // Both now cached — no new gh calls
      await tracker.getIssue("123", project);
      await tracker.getIssue("456", project);
      expect(ghMock).toHaveBeenCalledTimes(2);
    });

    it("different repos cache independently", async () => {
      const otherProject: ProjectConfig = { ...project, repo: "acme/other" };
      mockGh(sampleIssue);
      mockGh(sampleIssue);
      await tracker.getIssue("123", project);
      await tracker.getIssue("123", otherProject);
      expect(ghMock).toHaveBeenCalledTimes(2);
    });

    it("strips '#' prefix — '#123' and '123' share a cache entry", async () => {
      mockGh(sampleIssue);
      await tracker.getIssue("#123", project);
      await tracker.getIssue("123", project);
      expect(ghMock).toHaveBeenCalledTimes(1);
    });

    it("updateIssue invalidates the cache entry", async () => {
      mockGh(sampleIssue);
      await tracker.getIssue("123", project);
      expect(ghMock).toHaveBeenCalledTimes(1);

      ghMock.mockResolvedValueOnce({ stdout: "" }); // gh issue close
      await tracker.updateIssue!("123", { state: "closed" }, project);

      // Next getIssue must re-fetch from gh
      mockGh({ ...sampleIssue, state: "CLOSED", stateReason: "COMPLETED" });
      const fresh = await tracker.getIssue("123", project);
      expect(fresh.state).toBe("closed");
      expect(ghMock).toHaveBeenCalledTimes(3); // view + close + view again
    });

    it("entries expire after TTL", async () => {
      vi.useFakeTimers();
      try {
        mockGh(sampleIssue);
        await tracker.getIssue("123", project);
        expect(ghMock).toHaveBeenCalledTimes(1);

        // Advance time past TTL (5 min)
        vi.advanceTimersByTime(5 * 60_000 + 1);

        mockGh(sampleIssue);
        await tracker.getIssue("123", project);
        expect(ghMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("each create() returns a tracker with an isolated cache", async () => {
      const trackerA = create();
      const trackerB = create();
      mockGh(sampleIssue);
      await trackerA.getIssue("123", project);
      mockGh(sampleIssue);
      await trackerB.getIssue("123", project);
      expect(ghMock).toHaveBeenCalledTimes(2);
    });

    it("failures are not cached", async () => {
      mockGhError("issue not found");
      await expect(tracker.getIssue("999", project)).rejects.toThrow();
      // Next call must re-try, not serve a stale error
      mockGh({ ...sampleIssue, number: 999 });
      const issue = await tracker.getIssue("999", project);
      expect(issue.id).toBe("999");
      expect(ghMock).toHaveBeenCalledTimes(2);
    });
  });

  // ---- issueUrl ----------------------------------------------------------

  describe("issueUrl", () => {
    it("generates correct URL", () => {
      expect(tracker.issueUrl("42", project)).toBe("https://github.com/acme/repo/issues/42");
    });

    it("strips # prefix from identifier", () => {
      expect(tracker.issueUrl("#42", project)).toBe("https://github.com/acme/repo/issues/42");
    });
  });

  // ---- branchName --------------------------------------------------------

  describe("branchName", () => {
    it("generates feat/issue-N format", () => {
      expect(tracker.branchName("42", project)).toBe("feat/issue-42");
    });

    it("strips # prefix", () => {
      expect(tracker.branchName("#42", project)).toBe("feat/issue-42");
    });
  });

  // ---- generatePrompt ----------------------------------------------------

  describe("generatePrompt", () => {
    it("includes title and URL", async () => {
      mockGh(sampleIssue);
      const prompt = await tracker.generatePrompt("123", project);
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("https://github.com/acme/repo/issues/123");
      expect(prompt).toContain("GitHub issue #123");
    });

    it("includes labels when present", async () => {
      mockGh(sampleIssue);
      const prompt = await tracker.generatePrompt("123", project);
      expect(prompt).toContain("bug, priority-high");
    });

    it("includes description", async () => {
      mockGh(sampleIssue);
      const prompt = await tracker.generatePrompt("123", project);
      expect(prompt).toContain("Users can't log in with SSO");
    });

    it("omits labels section when no labels", async () => {
      mockGh({ ...sampleIssue, labels: [] });
      const prompt = await tracker.generatePrompt("123", project);
      expect(prompt).not.toContain("Labels:");
    });

    it("omits description section when body is empty", async () => {
      mockGh({ ...sampleIssue, body: null });
      const prompt = await tracker.generatePrompt("123", project);
      expect(prompt).not.toContain("## Description");
    });
  });

  // ---- listIssues --------------------------------------------------------

  describe("listIssues", () => {
    it("returns mapped issues", async () => {
      mockGh([sampleIssue, { ...sampleIssue, number: 456, title: "Another" }]);
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe("123");
      expect(issues[1].id).toBe("456");
    });

    it("passes state filter for closed issues", async () => {
      mockGh([]);
      await tracker.listIssues!({ state: "closed" }, project);
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        expect.arrayContaining(["--state", "closed"]),
        expect.any(Object),
      );
    });

    it("passes state filter for all issues", async () => {
      mockGh([]);
      await tracker.listIssues!({ state: "all" }, project);
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        expect.arrayContaining(["--state", "all"]),
        expect.any(Object),
      );
    });

    it("defaults to open state", async () => {
      mockGh([]);
      await tracker.listIssues!({}, project);
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        expect.arrayContaining(["--state", "open"]),
        expect.any(Object),
      );
    });

    it("passes label filter", async () => {
      mockGh([]);
      await tracker.listIssues!({ labels: ["bug", "urgent"] }, project);
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        expect.arrayContaining(["--label", "bug,urgent"]),
        expect.any(Object),
      );
    });

    it("passes assignee filter", async () => {
      mockGh([]);
      await tracker.listIssues!({ assignee: "alice" }, project);
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        expect.arrayContaining(["--assignee", "alice"]),
        expect.any(Object),
      );
    });

    it("respects custom limit", async () => {
      mockGh([]);
      await tracker.listIssues!({ limit: 5 }, project);
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        expect.arrayContaining(["--limit", "5"]),
        expect.any(Object),
      );
    });

    it("falls back to legacy JSON fields when stateReason is unsupported", async () => {
      mockGhError('gh issue list failed: Unknown JSON field "stateReason"');
      mockGh([{ ...sampleIssue, stateReason: undefined }]);

      const issues = await tracker.listIssues!({}, project);

      expect(issues).toHaveLength(1);
      expect(issues[0]?.id).toBe("123");
      expect(ghMock).toHaveBeenCalledTimes(2);
      expect(ghMock.mock.calls[0]?.[1]).toEqual(
        expect.arrayContaining([expect.stringContaining("state,stateReason")]),
      );
      expect(ghMock.mock.calls[1]?.[1]).toEqual(
        expect.arrayContaining([expect.stringContaining("state,labels,assignees")]),
      );
    });

    it("falls back for list when stateReason error uses alternate wording", async () => {
      mockGhError("gh issue list failed: unknown field stateReason");
      mockGh([{ ...sampleIssue, stateReason: undefined }]);

      const issues = await tracker.listIssues!({}, project);

      expect(issues).toHaveLength(1);
      expect(ghMock).toHaveBeenCalledTimes(2);
    });
  });

  // ---- updateIssue -------------------------------------------------------

  describe("updateIssue", () => {
    it("closes an issue", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("123", { state: "closed" }, project);
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        ["issue", "close", "123", "--repo", "acme/repo"],
        expect.any(Object),
      );
    });

    it("reopens an issue", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("123", { state: "open" }, project);
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        ["issue", "reopen", "123", "--repo", "acme/repo"],
        expect.any(Object),
      );
    });

    it("adds labels", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("123", { labels: ["bug", "urgent"] }, project);
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        ["issue", "edit", "123", "--repo", "acme/repo", "--add-label", "bug,urgent"],
        expect.any(Object),
      );
    });

    it("adds assignee", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("123", { assignee: "bob" }, project);
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        ["issue", "edit", "123", "--repo", "acme/repo", "--add-assignee", "bob"],
        expect.any(Object),
      );
    });

    it("adds comment", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("123", { comment: "Working on this" }, project);
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        ["issue", "comment", "123", "--repo", "acme/repo", "--body", "Working on this"],
        expect.any(Object),
      );
    });

    it("handles multiple updates in one call", async () => {
      ghMock.mockResolvedValue({ stdout: "" });
      await tracker.updateIssue!(
        "123",
        { state: "closed", labels: ["done"], comment: "Done!" },
        project,
      );
      // Should have called gh 3 times: close + edit labels + comment
      expect(ghMock).toHaveBeenCalledTimes(3);
    });
  });

  // ---- createIssue -------------------------------------------------------

  describe("createIssue", () => {
    it("creates an issue and fetches full details", async () => {
      // First call: gh issue create returns URL
      mockGhRaw("https://github.com/acme/repo/issues/999\n");
      // Second call: getIssue fetches the created issue
      mockGh({
        number: 999,
        title: "New issue",
        body: "Description",
        url: "https://github.com/acme/repo/issues/999",
        state: "OPEN",
        stateReason: null,
        labels: [],
        assignees: [],
      });

      const issue = await tracker.createIssue!(
        { title: "New issue", description: "Description" },
        project,
      );
      expect(issue).toMatchObject({ id: "999", title: "New issue", state: "open" });
    });

    it("passes labels and assignee to gh issue create", async () => {
      mockGhRaw("https://github.com/acme/repo/issues/1000\n");
      mockGh({
        number: 1000,
        title: "Bug",
        body: "Crash",
        url: "https://github.com/acme/repo/issues/1000",
        state: "OPEN",
        stateReason: null,
        labels: [{ name: "bug" }],
        assignees: [{ login: "alice" }],
      });

      await tracker.createIssue!(
        { title: "Bug", description: "Crash", labels: ["bug"], assignee: "alice" },
        project,
      );
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        expect.arrayContaining(["issue", "create", "--label", "bug", "--assignee", "alice"]),
        expect.any(Object),
      );
    });

    it("throws when URL cannot be parsed from gh output", async () => {
      mockGhRaw("unexpected output");
      await expect(
        tracker.createIssue!({ title: "Test", description: "" }, project),
      ).rejects.toThrow("Failed to parse issue URL");
    });
  });

  describe("preflight", () => {
    const ctx: PreflightContext = {
      project,
      intent: { role: "worker", willClaimExistingPR: false },
    };

    beforeEach(() => {
      // Process cache spans tests; clear so each one starts fresh.
      _clearProcessCacheForTests();
    });

    it("resolves when gh is installed and authenticated", async () => {
      mockGhRaw("gh version 2.40.0"); // gh --version
      mockGhRaw("Logged in to github.com as alice"); // gh auth status
      await expect(tracker.preflight!(ctx)).resolves.toBeUndefined();
    });

    it("throws 'not installed' when `gh --version` fails", async () => {
      mockGhError("ENOENT");
      const err = (await tracker.preflight!(ctx).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("GitHub CLI (gh) is not installed");
      expect(err.message).toContain("https://cli.github.com/");
    });

    it("throws 'not authenticated' when `gh auth status` fails", async () => {
      mockGhRaw("gh version 2.40.0");
      mockGhError("not logged in");
      const err = (await tracker.preflight!(ctx).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("not authenticated");
      expect(err.message).toContain("gh auth login");
    });
  });
});
