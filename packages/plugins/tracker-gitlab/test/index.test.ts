import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:child_process
// ---------------------------------------------------------------------------
const { glabMock } = vi.hoisted(() => ({ glabMock: vi.fn() }));

vi.mock("node:child_process", () => {
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: glabMock,
  });
  return { execFile };
});

import { create, manifest } from "../src/index.js";
import type { ProjectConfig } from "@aoagents/ao-core";

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

function mockGlab(result: unknown) {
  glabMock.mockResolvedValueOnce({ stdout: JSON.stringify(result) });
}

function mockGlabRaw(stdout: string) {
  glabMock.mockResolvedValueOnce({ stdout });
}

function mockGlabError(msg = "Command failed") {
  glabMock.mockRejectedValueOnce(new Error(msg));
}

const sampleIssue = {
  iid: 123,
  title: "Fix login bug",
  description: "Users can't log in with SSO",
  web_url: "https://gitlab.com/acme/repo/-/issues/123",
  state: "opened",
  labels: ["bug", "priority-high"],
  assignees: [{ username: "alice" }],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tracker-gitlab plugin", () => {
  let tracker: ReturnType<typeof create>;

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = create();
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("gitlab");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("gitlab");
    });
  });

  // ---- getIssue ----------------------------------------------------------

  describe("getIssue", () => {
    it("returns Issue with correct fields", async () => {
      mockGlab(sampleIssue);
      const issue = await tracker.getIssue("123", project);
      expect(issue).toEqual({
        id: "123",
        title: "Fix login bug",
        description: "Users can't log in with SSO",
        url: "https://gitlab.com/acme/repo/-/issues/123",
        state: "open",
        labels: ["bug", "priority-high"],
        assignee: "alice",
      });
    });

    it("maps closed state to closed", async () => {
      mockGlab({ ...sampleIssue, state: "closed" });
      const issue = await tracker.getIssue("123", project);
      expect(issue.state).toBe("closed");
    });

    it("handles missing description gracefully", async () => {
      mockGlab({ ...sampleIssue, description: null });
      const issue = await tracker.getIssue("123", project);
      expect(issue.description).toBe("");
    });

    it("handles empty assignees", async () => {
      mockGlab({ ...sampleIssue, assignees: [] });
      const issue = await tracker.getIssue("123", project);
      expect(issue.assignee).toBeUndefined();
    });

    it("handles labels as string array (GitLab format)", async () => {
      mockGlab({ ...sampleIssue, labels: ["bug", "urgent"] });
      const issue = await tracker.getIssue("123", project);
      expect(issue.labels).toEqual(["bug", "urgent"]);
    });

    it("propagates glab CLI errors", async () => {
      mockGlabError("issue not found");
      await expect(tracker.getIssue("999", project)).rejects.toThrow("issue not found");
    });

    it("throws on malformed JSON response", async () => {
      glabMock.mockResolvedValueOnce({ stdout: "not json{" });
      await expect(tracker.getIssue("123", project)).rejects.toThrow();
    });
  });

  // ---- isCompleted -------------------------------------------------------

  describe("isCompleted", () => {
    it("returns true for closed issues", async () => {
      mockGlab({ state: "closed" });
      expect(await tracker.isCompleted("123", project)).toBe(true);
    });

    it("returns false for opened issues", async () => {
      mockGlab({ state: "opened" });
      expect(await tracker.isCompleted("123", project)).toBe(false);
    });

    it("handles uppercase state", async () => {
      mockGlab({ state: "Closed" });
      expect(await tracker.isCompleted("123", project)).toBe(true);
    });
  });

  // ---- issueUrl ----------------------------------------------------------

  describe("issueUrl", () => {
    it("generates correct URL for gitlab.com", () => {
      expect(tracker.issueUrl("42", project)).toBe(
        "https://gitlab.com/acme/repo/-/issues/42",
      );
    });

    it("strips # prefix from identifier", () => {
      expect(tracker.issueUrl("#42", project)).toBe(
        "https://gitlab.com/acme/repo/-/issues/42",
      );
    });

    it("uses custom host when configured", () => {
      const customTracker = create({ host: "gitlab.example.com" });
      expect(customTracker.issueUrl("42", project)).toBe(
        "https://gitlab.example.com/acme/repo/-/issues/42",
      );
    });

    it("infers host from project.repo when config.host is unset", () => {
      const selfHostedProject = { ...project, repo: "gitlab.corp.com/org/repo" };
      expect(tracker.issueUrl("42", selfHostedProject)).toBe(
        "https://gitlab.corp.com/org/repo/-/issues/42",
      );
    });

    it("strips hostname from project.repo with custom host", () => {
      const customTracker = create({ host: "gitlab.corp.com" });
      const selfHostedProject = { ...project, repo: "gitlab.corp.com/org/repo" };
      expect(customTracker.issueUrl("42", selfHostedProject)).toBe(
        "https://gitlab.corp.com/org/repo/-/issues/42",
      );
    });

    it("does not treat dotted group name as hostname (only 2 segments)", () => {
      const dottedGroupProject = { ...project, repo: "my.company/repo" };
      expect(tracker.issueUrl("42", dottedGroupProject)).toBe(
        "https://gitlab.com/my.company/repo/-/issues/42",
      );
    });
  });

  // ---- issueLabel --------------------------------------------------------

  describe("issueLabel", () => {
    it("extracts issue number from GitLab URL", () => {
      expect(
        tracker.issueLabel!("https://gitlab.com/acme/repo/-/issues/42", project),
      ).toBe("#42");
    });

    it("falls back to last URL segment", () => {
      expect(tracker.issueLabel!("https://example.com/something/42", project)).toBe("#42");
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
      mockGlab(sampleIssue);
      const prompt = await tracker.generatePrompt("123", project);
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("https://gitlab.com/acme/repo/-/issues/123");
      expect(prompt).toContain("GitLab issue #123");
    });

    it("includes labels when present", async () => {
      mockGlab(sampleIssue);
      const prompt = await tracker.generatePrompt("123", project);
      expect(prompt).toContain("bug, priority-high");
    });

    it("includes description", async () => {
      mockGlab(sampleIssue);
      const prompt = await tracker.generatePrompt("123", project);
      expect(prompt).toContain("Users can't log in with SSO");
    });

    it("omits labels section when no labels", async () => {
      mockGlab({ ...sampleIssue, labels: [] });
      const prompt = await tracker.generatePrompt("123", project);
      expect(prompt).not.toContain("Labels:");
    });

    it("omits description section when body is empty", async () => {
      mockGlab({ ...sampleIssue, description: null });
      const prompt = await tracker.generatePrompt("123", project);
      expect(prompt).not.toContain("## Description");
    });
  });

  // ---- listIssues --------------------------------------------------------

  describe("listIssues", () => {
    it("returns mapped issues", async () => {
      mockGlab([sampleIssue, { ...sampleIssue, iid: 456, title: "Another" }]);
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe("123");
      expect(issues[1].id).toBe("456");
    });

    it("passes --closed filter for closed issues", async () => {
      mockGlab([]);
      await tracker.listIssues!({ state: "closed" }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        expect.arrayContaining(["--closed"]),
        expect.any(Object),
      );
    });

    it("passes --all filter for all issues", async () => {
      mockGlab([]);
      await tracker.listIssues!({ state: "all" }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        expect.arrayContaining(["--all"]),
        expect.any(Object),
      );
    });

    it("defaults to open state (no --closed or --all)", async () => {
      mockGlab([]);
      await tracker.listIssues!({}, project);
      const args = glabMock.mock.calls[0][1] as string[];
      expect(args).not.toContain("--closed");
      expect(args).not.toContain("--all");
    });

    it("passes label filter", async () => {
      mockGlab([]);
      await tracker.listIssues!({ labels: ["bug", "urgent"] }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        expect.arrayContaining(["--label", "bug", "--label", "urgent"]),
        expect.any(Object),
      );
    });

    it("passes assignee filter", async () => {
      mockGlab([]);
      await tracker.listIssues!({ assignee: "alice" }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        expect.arrayContaining(["--assignee", "alice"]),
        expect.any(Object),
      );
    });

    it("respects custom limit", async () => {
      mockGlab([]);
      await tracker.listIssues!({ limit: 5 }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        expect.arrayContaining(["-P", "5"]),
        expect.any(Object),
      );
    });
  });

  // ---- updateIssue -------------------------------------------------------

  describe("updateIssue", () => {
    it("closes an issue", async () => {
      glabMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("123", { state: "closed" }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        ["issue", "close", "123", "--repo", "acme/repo"],
        expect.any(Object),
      );
    });

    it("reopens an issue", async () => {
      glabMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("123", { state: "open" }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        ["issue", "reopen", "123", "--repo", "acme/repo"],
        expect.any(Object),
      );
    });

    it("adds labels", async () => {
      glabMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("123", { labels: ["bug", "urgent"] }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        ["issue", "update", "123", "--repo", "acme/repo", "--label", "bug,urgent"],
        expect.any(Object),
      );
    });

    it("adds comment", async () => {
      glabMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("123", { comment: "Working on this" }, project);
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        ["issue", "note", "123", "--repo", "acme/repo", "-m", "Working on this"],
        expect.any(Object),
      );
    });

    it("handles multiple updates in one call", async () => {
      glabMock.mockResolvedValue({ stdout: "" });
      await tracker.updateIssue!(
        "123",
        { state: "closed", labels: ["done"], comment: "Done!" },
        project,
      );
      expect(glabMock).toHaveBeenCalledTimes(3);
    });
  });

  // ---- createIssue -------------------------------------------------------

  describe("createIssue", () => {
    it("creates an issue and fetches full details", async () => {
      mockGlabRaw("https://gitlab.com/acme/repo/-/issues/999\n");
      mockGlab({
        iid: 999,
        title: "New issue",
        description: "Description",
        web_url: "https://gitlab.com/acme/repo/-/issues/999",
        state: "opened",
        labels: [],
        assignees: [],
      });

      const issue = await tracker.createIssue!(
        { title: "New issue", description: "Description" },
        project,
      );
      expect(issue).toMatchObject({ id: "999", title: "New issue", state: "open" });
    });

    it("passes labels and assignee to glab issue create", async () => {
      mockGlabRaw("https://gitlab.com/acme/repo/-/issues/1000\n");
      mockGlab({
        iid: 1000,
        title: "Bug",
        description: "Crash",
        web_url: "https://gitlab.com/acme/repo/-/issues/1000",
        state: "opened",
        labels: ["bug"],
        assignees: [{ username: "alice" }],
      });

      await tracker.createIssue!(
        { title: "Bug", description: "Crash", labels: ["bug"], assignee: "alice" },
        project,
      );
      expect(glabMock).toHaveBeenCalledWith(
        "glab",
        expect.arrayContaining(["issue", "create", "--label", "bug", "--assignee", "alice"]),
        expect.any(Object),
      );
    });

    it("throws when URL cannot be parsed from glab output", async () => {
      mockGlabRaw("unexpected output");
      await expect(
        tracker.createIssue!({ title: "Test", description: "" }, project),
      ).rejects.toThrow("Failed to parse issue URL");
    });
  });
});
