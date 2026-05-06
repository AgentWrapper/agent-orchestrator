import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Mock node:https
// ---------------------------------------------------------------------------

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock("node:https", () => ({
  request: requestMock,
}));

import { create, manifest } from "../src/index.js";
import type { ProjectConfig } from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const project: ProjectConfig = {
  name: "test",
  repo: "acme/integrator",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
  tracker: {
    plugin: "linear",
    teamId: "team-uuid-1",
    workspaceSlug: "acme",
  },
};

const projectNoSlug: ProjectConfig = {
  ...project,
  tracker: { plugin: "linear", teamId: "team-uuid-1" },
};

const sampleIssueNode = {
  id: "uuid-123",
  identifier: "INT-123",
  title: "Fix login bug",
  description: "Users can't log in with SSO",
  url: "https://linear.app/acme/issue/INT-123",
  priority: 2,
  branchName: "feat/INT-123",
  state: { name: "In Progress", type: "started" },
  labels: { nodes: [{ name: "bug" }, { name: "high-priority" }] },
  assignee: { name: "Alice Smith", displayName: "Alice" },
  team: { key: "INT" },
};

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Queue a successful Linear API response.
 * Each call to linearQuery() will consume the next queued response.
 */
function mockLinearAPI(responseData: unknown, statusCode = 200) {
  const body = JSON.stringify({ data: responseData });

  requestMock.mockImplementationOnce(
    (
      _opts: Record<string, unknown>,
      callback: (res: EventEmitter & { statusCode: number }) => void,
    ) => {
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(() => {
          const res = Object.assign(new EventEmitter(), { statusCode });
          callback(res);
          process.nextTick(() => {
            res.emit("data", Buffer.from(body));
            res.emit("end");
          });
        }),
        destroy: vi.fn(),
        setTimeout: vi.fn(),
      });
      return req;
    },
  );
}

/** Queue a Linear API error response (GraphQL errors array). */
function mockLinearError(message: string) {
  const body = JSON.stringify({ errors: [{ message }] });

  requestMock.mockImplementationOnce(
    (
      _opts: Record<string, unknown>,
      callback: (res: EventEmitter & { statusCode: number }) => void,
    ) => {
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(() => {
          const res = Object.assign(new EventEmitter(), { statusCode: 200 });
          callback(res);
          process.nextTick(() => {
            res.emit("data", Buffer.from(body));
            res.emit("end");
          });
        }),
        destroy: vi.fn(),
        setTimeout: vi.fn(),
      });
      return req;
    },
  );
}

/** Queue an HTTP-level error (non-200 status). */
function mockHTTPError(statusCode: number, body: string) {
  requestMock.mockImplementationOnce(
    (
      _opts: Record<string, unknown>,
      callback: (res: EventEmitter & { statusCode: number }) => void,
    ) => {
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(() => {
          const res = Object.assign(new EventEmitter(), { statusCode });
          callback(res);
          process.nextTick(() => {
            res.emit("data", Buffer.from(body));
            res.emit("end");
          });
        }),
        destroy: vi.fn(),
        setTimeout: vi.fn(),
      });
      return req;
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tracker-linear plugin", () => {
  let tracker: ReturnType<typeof create>;
  let savedApiKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedApiKey = process.env["LINEAR_API_KEY"];
    process.env["LINEAR_API_KEY"] = "lin_api_test_key";
    tracker = create();
  });

  afterEach(() => {
    if (savedApiKey === undefined) {
      delete process.env["LINEAR_API_KEY"];
    } else {
      process.env["LINEAR_API_KEY"] = savedApiKey;
    }
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("linear");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("linear");
    });
  });

  // ---- getIssue ----------------------------------------------------------

  describe("getIssue", () => {
    it("returns Issue with correct fields", async () => {
      mockLinearAPI({ issue: sampleIssueNode });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue).toEqual({
        id: "INT-123",
        title: "Fix login bug",
        description: "Users can't log in with SSO",
        url: "https://linear.app/acme/issue/INT-123",
        state: "in_progress",
        labels: ["bug", "high-priority"],
        assignee: "Alice",
        priority: 2,
        branchName: "feat/INT-123",
      });
    });

    it("maps completed state to closed", async () => {
      mockLinearAPI({
        issue: { ...sampleIssueNode, state: { name: "Done", type: "completed" } },
      });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.state).toBe("closed");
    });

    it("maps canceled state to cancelled", async () => {
      mockLinearAPI({
        issue: { ...sampleIssueNode, state: { name: "Canceled", type: "canceled" } },
      });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.state).toBe("cancelled");
    });

    it("maps backlog/triage/unstarted to open", async () => {
      for (const type of ["backlog", "triage", "unstarted"]) {
        mockLinearAPI({
          issue: { ...sampleIssueNode, state: { name: type, type } },
        });
        const issue = await tracker.getIssue("INT-123", project);
        expect(issue.state).toBe("open");
      }
    });

    it("handles null description", async () => {
      mockLinearAPI({
        issue: { ...sampleIssueNode, description: null },
      });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.description).toBe("");
    });

    it("handles null assignee", async () => {
      mockLinearAPI({
        issue: { ...sampleIssueNode, assignee: null },
      });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.assignee).toBeUndefined();
    });

    it("uses assignee name as fallback when displayName is missing", async () => {
      mockLinearAPI({
        issue: {
          ...sampleIssueNode,
          assignee: { name: "Alice Smith", displayName: undefined },
        },
      });
      const issue = await tracker.getIssue("INT-123", project);
      // undefined displayName falls through to name via ??
      expect(issue.assignee).toBe("Alice Smith");
    });

    it("handles empty labels", async () => {
      mockLinearAPI({
        issue: { ...sampleIssueNode, labels: { nodes: [] } },
      });
      const issue = await tracker.getIssue("INT-123", project);
      expect(issue.labels).toEqual([]);
    });

    it("propagates API errors", async () => {
      mockLinearError("Issue not found");
      await expect(tracker.getIssue("INT-999", project)).rejects.toThrow(
        "Linear API error: Issue not found",
      );
    });

    it("throws when LINEAR_API_KEY is missing", async () => {
      delete process.env["LINEAR_API_KEY"];
      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "LINEAR_API_KEY environment variable is required",
      );
    });

    it("throws on HTTP errors", async () => {
      mockHTTPError(500, "Internal Server Error");
      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "Linear API returned HTTP 500",
      );
    });
  });

  // ---- isCompleted -------------------------------------------------------

  describe("isCompleted", () => {
    it("returns true for completed state", async () => {
      mockLinearAPI({ issue: { state: { type: "completed" } } });
      expect(await tracker.isCompleted("INT-123", project)).toBe(true);
    });

    it("returns true for canceled state", async () => {
      mockLinearAPI({ issue: { state: { type: "canceled" } } });
      expect(await tracker.isCompleted("INT-123", project)).toBe(true);
    });

    it("returns false for started state", async () => {
      mockLinearAPI({ issue: { state: { type: "started" } } });
      expect(await tracker.isCompleted("INT-123", project)).toBe(false);
    });

    it("returns false for unstarted state", async () => {
      mockLinearAPI({ issue: { state: { type: "unstarted" } } });
      expect(await tracker.isCompleted("INT-123", project)).toBe(false);
    });
  });

  // ---- issueUrl ----------------------------------------------------------

  describe("issueUrl", () => {
    it("generates correct URL with workspace slug", () => {
      expect(tracker.issueUrl("INT-123", project)).toBe("https://linear.app/acme/issue/INT-123");
    });

    it("generates fallback URL without workspace slug", () => {
      expect(tracker.issueUrl("INT-123", projectNoSlug)).toBe("https://linear.app/issue/INT-123");
    });

    it("generates fallback URL when no tracker config", () => {
      const noTracker: ProjectConfig = { ...project, tracker: undefined };
      expect(tracker.issueUrl("INT-123", noTracker)).toBe("https://linear.app/issue/INT-123");
    });
  });

  // ---- branchName --------------------------------------------------------

  describe("branchName", () => {
    it("generates feat/ prefix branch name", () => {
      expect(tracker.branchName("INT-123", project)).toBe("feat/INT-123");
    });
  });

  // ---- generatePrompt ----------------------------------------------------

  describe("generatePrompt", () => {
    it("includes title, URL, and description", async () => {
      mockLinearAPI({ issue: sampleIssueNode });
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).toContain("INT-123");
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("https://linear.app/acme/issue/INT-123");
      expect(prompt).toContain("Users can't log in with SSO");
    });

    it("includes labels when present", async () => {
      mockLinearAPI({ issue: sampleIssueNode });
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).toContain("bug, high-priority");
    });

    it("includes priority", async () => {
      mockLinearAPI({ issue: sampleIssueNode });
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).toContain("High");
    });

    it("maps priority numbers to names", async () => {
      const priorities: Record<number, string> = {
        0: "No priority",
        1: "Urgent",
        2: "High",
        3: "Normal",
        4: "Low",
      };
      for (const [num, name] of Object.entries(priorities)) {
        mockLinearAPI({
          issue: { ...sampleIssueNode, priority: Number(num) },
        });
        const prompt = await tracker.generatePrompt("INT-123", project);
        expect(prompt).toContain(name);
      }
    });

    it("omits description section when empty", async () => {
      mockLinearAPI({
        issue: { ...sampleIssueNode, description: null },
      });
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).not.toContain("## Description");
    });

    it("omits labels line when no labels", async () => {
      mockLinearAPI({
        issue: { ...sampleIssueNode, labels: { nodes: [] } },
      });
      const prompt = await tracker.generatePrompt("INT-123", project);
      expect(prompt).not.toContain("Labels:");
    });
  });

  // ---- listIssues --------------------------------------------------------

  describe("listIssues", () => {
    it("returns mapped issues", async () => {
      mockLinearAPI({
        issues: {
          nodes: [sampleIssueNode, { ...sampleIssueNode, identifier: "INT-456", title: "Another" }],
        },
      });
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe("INT-123");
      expect(issues[1].id).toBe("INT-456");
    });

    it("passes state filter for open issues", async () => {
      mockLinearAPI({ issues: { nodes: [] } });
      await tracker.listIssues!({ state: "open" }, project);

      // Verify the request body contains the correct filter
      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.filter.state).toEqual({
        type: { nin: ["completed", "canceled"] },
      });
    });

    it("passes state filter for closed issues", async () => {
      mockLinearAPI({ issues: { nodes: [] } });
      await tracker.listIssues!({ state: "closed" }, project);

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.filter.state).toEqual({
        type: { in: ["completed", "canceled"] },
      });
    });

    it("defaults to open state when no state specified", async () => {
      mockLinearAPI({ issues: { nodes: [] } });
      await tracker.listIssues!({}, project);

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.filter.state).toEqual({
        type: { nin: ["completed", "canceled"] },
      });
    });

    it("passes assignee filter", async () => {
      mockLinearAPI({ issues: { nodes: [] } });
      await tracker.listIssues!({ assignee: "Alice" }, project);

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.filter.assignee).toEqual({
        displayName: { eq: "Alice" },
      });
    });

    it("passes labels filter", async () => {
      mockLinearAPI({ issues: { nodes: [] } });
      await tracker.listIssues!({ labels: ["bug", "urgent"] }, project);

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.filter.labels).toEqual({
        name: { in: ["bug", "urgent"] },
      });
    });

    it("passes team filter from project config", async () => {
      mockLinearAPI({ issues: { nodes: [] } });
      await tracker.listIssues!({}, project);

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.filter.team).toEqual({
        id: { eq: "team-uuid-1" },
      });
    });

    it("respects custom limit", async () => {
      mockLinearAPI({ issues: { nodes: [] } });
      await tracker.listIssues!({ limit: 5 }, project);

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.first).toBe(5);
    });

    it("defaults limit to 30", async () => {
      mockLinearAPI({ issues: { nodes: [] } });
      await tracker.listIssues!({}, project);

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.first).toBe(30);
    });
  });

  // ---- updateIssue -------------------------------------------------------

  describe("updateIssue", () => {
    const workflowStates = {
      workflowStates: {
        nodes: [
          { id: "state-1", name: "Todo", type: "unstarted" },
          { id: "state-2", name: "In Progress", type: "started" },
          { id: "state-3", name: "Done", type: "completed" },
        ],
      },
    };

    it("changes state to closed (completed)", async () => {
      // 1st: resolve identifier to UUID
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      // 2nd: fetch workflow states
      mockLinearAPI(workflowStates);
      // 3rd: issueUpdate mutation
      mockLinearAPI({ issueUpdate: { success: true } });

      await tracker.updateIssue!("INT-123", { state: "closed" }, project);
      expect(requestMock).toHaveBeenCalledTimes(3);
    });

    it("changes state to open (unstarted)", async () => {
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      mockLinearAPI(workflowStates);
      mockLinearAPI({ issueUpdate: { success: true } });

      await tracker.updateIssue!("INT-123", { state: "open" }, project);

      // Verify the mutation uses the unstarted state ID
      const writeCall = requestMock.mock.results[2].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.stateId).toBe("state-1");
    });

    it("changes state to in_progress (started)", async () => {
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      mockLinearAPI(workflowStates);
      mockLinearAPI({ issueUpdate: { success: true } });

      await tracker.updateIssue!("INT-123", { state: "in_progress" }, project);

      const writeCall = requestMock.mock.results[2].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.stateId).toBe("state-2");
    });

    it("throws when target workflow state is not found", async () => {
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      // Return states without "completed"
      mockLinearAPI({
        workflowStates: {
          nodes: [{ id: "state-1", name: "Todo", type: "unstarted" }],
        },
      });

      await expect(tracker.updateIssue!("INT-123", { state: "closed" }, project)).rejects.toThrow(
        'No workflow state of type "completed"',
      );
    });

    it("adds a comment", async () => {
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      mockLinearAPI({ commentCreate: { success: true } });

      await tracker.updateIssue!("INT-123", { comment: "Working on this" }, project);
      expect(requestMock).toHaveBeenCalledTimes(2);

      // Verify comment body
      const writeCall = requestMock.mock.results[1].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.body).toBe("Working on this");
    });

    it("handles state change + comment together", async () => {
      // 1: resolve identifier
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      // 2: workflow states
      mockLinearAPI(workflowStates);
      // 3: issueUpdate (state)
      mockLinearAPI({ issueUpdate: { success: true } });
      // 4: commentCreate
      mockLinearAPI({ commentCreate: { success: true } });

      await tracker.updateIssue!("INT-123", { state: "closed", comment: "Done!" }, project);
      expect(requestMock).toHaveBeenCalledTimes(4);
    });

    it("updates assignee by resolving display name to ID", async () => {
      // 1: resolve identifier
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      // 2: user lookup
      mockLinearAPI({
        users: { nodes: [{ id: "user-1", displayName: "Alice", name: "Alice Smith" }] },
      });
      // 3: issueUpdate (assignee)
      mockLinearAPI({ issueUpdate: { success: true } });

      await tracker.updateIssue!("INT-123", { assignee: "Alice" }, project);
      expect(requestMock).toHaveBeenCalledTimes(3);

      const writeCall = requestMock.mock.results[2].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.assigneeId).toBe("user-1");
    });

    it("updates labels additively (merges with existing)", async () => {
      // 1: resolve identifier
      mockLinearAPI({ issue: { id: "uuid-123", team: { id: "team-1" } } });
      // 2: fetch existing labels on the issue
      mockLinearAPI({ issue: { labels: { nodes: [{ id: "label-existing" }] } } });
      // 3: team label lookup
      mockLinearAPI({
        issueLabels: {
          nodes: [
            { id: "label-1", name: "bug" },
            { id: "label-2", name: "urgent" },
          ],
        },
      });
      // 4: issueUpdate (labels)
      mockLinearAPI({ issueUpdate: { success: true } });

      await tracker.updateIssue!("INT-123", { labels: ["bug", "urgent"] }, project);
      expect(requestMock).toHaveBeenCalledTimes(4);

      const writeCall = requestMock.mock.results[3].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      // Should include existing + new labels
      expect(body.variables.labelIds).toEqual(
        expect.arrayContaining(["label-existing", "label-1", "label-2"]),
      );
      expect(body.variables.labelIds).toHaveLength(3);
    });
  });

  // ---- createIssue -------------------------------------------------------

  describe("createIssue", () => {
    it("creates a basic issue", async () => {
      mockLinearAPI({
        issueCreate: { success: true, issue: sampleIssueNode },
      });

      const issue = await tracker.createIssue!(
        { title: "Fix login bug", description: "Desc" },
        project,
      );
      expect(issue).toMatchObject({
        id: "INT-123",
        title: "Fix login bug",
        state: "in_progress",
        branchName: "feat/INT-123",
      });
    });

    it("passes priority to mutation", async () => {
      mockLinearAPI({
        issueCreate: { success: true, issue: sampleIssueNode },
      });

      await tracker.createIssue!({ title: "Bug", description: "", priority: 1 }, project);

      const writeCall = requestMock.mock.results[0].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.priority).toBe(1);
    });

    it("resolves assignee by display name after creation", async () => {
      // 1: create issue
      mockLinearAPI({
        issueCreate: {
          success: true,
          issue: { ...sampleIssueNode, assignee: null },
        },
      });
      // 2: look up user by display name
      mockLinearAPI({
        users: { nodes: [{ id: "user-1", displayName: "Alice", name: "Alice Smith" }] },
      });
      // 3: issueUpdate to assign
      mockLinearAPI({ issueUpdate: { success: true } });

      const issue = await tracker.createIssue!(
        { title: "Bug", description: "", assignee: "Alice" },
        project,
      );
      expect(issue.assignee).toBe("Alice");
      expect(requestMock).toHaveBeenCalledTimes(3);
    });

    it("skips assignee when user not found", async () => {
      mockLinearAPI({
        issueCreate: {
          success: true,
          issue: { ...sampleIssueNode, assignee: null },
        },
      });
      // User lookup returns empty
      mockLinearAPI({ users: { nodes: [] } });

      const issue = await tracker.createIssue!(
        { title: "Bug", description: "", assignee: "Unknown" },
        project,
      );
      expect(issue.assignee).toBeUndefined();
      // Only 2 calls: create + user lookup (no update since user not found)
      expect(requestMock).toHaveBeenCalledTimes(2);
    });

    it("adds labels after creation", async () => {
      mockLinearAPI({
        issueCreate: {
          success: true,
          issue: { ...sampleIssueNode, labels: { nodes: [] } },
        },
      });
      // Label lookup
      mockLinearAPI({
        issueLabels: {
          nodes: [
            { id: "label-1", name: "bug" },
            { id: "label-2", name: "urgent" },
            { id: "label-3", name: "other" },
          ],
        },
      });
      // issueUpdate to set labels
      mockLinearAPI({ issueUpdate: { success: true } });

      const issue = await tracker.createIssue!(
        { title: "Bug", description: "", labels: ["bug", "urgent"] },
        project,
      );
      expect(issue.labels).toEqual(["bug", "urgent"]);

      // Verify label IDs sent
      const writeCall = requestMock.mock.results[2].value.write.mock.calls[0][0];
      const body = JSON.parse(writeCall);
      expect(body.variables.labelIds).toEqual(["label-1", "label-2"]);
    });

    it("only reflects actually-applied labels when some don't exist", async () => {
      mockLinearAPI({
        issueCreate: {
          success: true,
          issue: { ...sampleIssueNode, labels: { nodes: [] } },
        },
      });
      // Only "bug" exists in Linear; "nonexistent" does not
      mockLinearAPI({
        issueLabels: {
          nodes: [{ id: "label-1", name: "bug" }],
        },
      });
      mockLinearAPI({ issueUpdate: { success: true } });

      const issue = await tracker.createIssue!(
        { title: "Bug", description: "", labels: ["bug", "nonexistent"] },
        project,
      );
      // Should only include the label that was actually found and applied
      expect(issue.labels).toEqual(["bug"]);
    });

    it("throws when teamId is missing from config", async () => {
      const noTeam: ProjectConfig = {
        ...project,
        tracker: { plugin: "linear" },
      };
      await expect(tracker.createIssue!({ title: "Bug", description: "" }, noTeam)).rejects.toThrow(
        "teamId",
      );
    });

    it("handles assignee error gracefully (best-effort)", async () => {
      mockLinearAPI({
        issueCreate: {
          success: true,
          issue: { ...sampleIssueNode, assignee: null },
        },
      });
      // User lookup fails
      mockLinearError("Internal error");

      const issue = await tracker.createIssue!(
        { title: "Bug", description: "", assignee: "Alice" },
        project,
      );
      // Should still return the issue without assignee
      expect(issue).toMatchObject({ id: "INT-123" });
      expect(issue.assignee).toBeUndefined();
    });

    it("handles label error gracefully (best-effort)", async () => {
      mockLinearAPI({
        issueCreate: {
          success: true,
          issue: { ...sampleIssueNode, labels: { nodes: [] } },
        },
      });
      // Label lookup fails
      mockLinearError("Internal error");

      const issue = await tracker.createIssue!(
        { title: "Bug", description: "", labels: ["bug"] },
        project,
      );
      // Should still return the issue without labels
      expect(issue).toMatchObject({ id: "INT-123" });
      expect(issue.labels).toEqual([]);
    });
  });

  // ---- linearQuery error handling ----------------------------------------

  describe("linearQuery error handling", () => {
    it("throws on missing LINEAR_API_KEY", async () => {
      delete process.env["LINEAR_API_KEY"];
      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow("LINEAR_API_KEY");
    });

    it("throws on GraphQL errors", async () => {
      mockLinearError("You do not have access");
      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "Linear API error: You do not have access",
      );
    });

    it("throws on HTTP error status", async () => {
      mockHTTPError(401, "Unauthorized");
      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "Linear API returned HTTP 401",
      );
    });

    it("throws on empty data response", async () => {
      const body = JSON.stringify({ data: null });
      requestMock.mockImplementationOnce(
        (
          _opts: Record<string, unknown>,
          callback: (res: EventEmitter & { statusCode: number }) => void,
        ) => {
          const req = Object.assign(new EventEmitter(), {
            write: vi.fn(),
            end: vi.fn(() => {
              const res = Object.assign(new EventEmitter(), { statusCode: 200 });
              callback(res);
              process.nextTick(() => {
                res.emit("data", Buffer.from(body));
                res.emit("end");
              });
            }),
            destroy: vi.fn(),
            setTimeout: vi.fn(),
          });
          return req;
        },
      );

      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "Linear API returned no data",
      );
    });
  });
});
