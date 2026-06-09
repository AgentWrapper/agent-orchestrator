import { describe, it, expect, beforeEach, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

import pluginDefault, { create, manifest } from "./index.js";
import type { ProjectConfig } from "@aoagents/ao-core";

const project: ProjectConfig = {
  name: "test",
  repo: "acme/app",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
  tracker: { plugin: "youtrack", projectId: "PROJ" },
};

const sampleIssue = {
  id: "2-123",
  idReadable: "PROJ-123",
  summary: "Fix login bug",
  description: "Users cannot log in with SSO.",
  resolved: null,
  tags: [{ id: "9-1", name: "agent:backlog" }],
  customFields: [
    {
      name: "State",
      $type: "StateIssueCustomField",
      value: { name: "In Progress", $type: "StateBundleElement" },
    },
    {
      name: "Priority",
      $type: "SingleEnumIssueCustomField",
      value: { name: "Major", $type: "EnumBundleElement" },
    },
    {
      name: "Assignee",
      $type: "SingleUserIssueCustomField",
      value: { name: "Alice Smith", login: "alice", $type: "User" },
    },
    {
      name: "Type",
      $type: "SingleEnumIssueCustomField",
      value: { name: "Bug", $type: "EnumBundleElement" },
    },
  ],
};

function mockFetchOk(data: unknown) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

function mockFetchError(status: number, body = "Error") {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status,
    text: () => Promise.resolve(body),
  });
}

describe("tracker-youtrack plugin", () => {
  let tracker: ReturnType<typeof create>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("YOUTRACK_HOST", "https://mycompany.youtrack.cloud");
    vi.stubEnv("YOUTRACK_TOKEN", "test-token");
    tracker = create();
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("youtrack");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("default export", () => {
    it("is a valid PluginModule", () => {
      expect(pluginDefault.manifest.name).toBe("youtrack");
      expect(typeof pluginDefault.create).toBe("function");
    });
  });

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("youtrack");
    });

    it("captures plugin config for host and token", async () => {
      vi.stubEnv("YOUTRACK_HOST", "");
      vi.stubEnv("YOUTRACK_TOKEN", "");
      const configuredTracker = create({
        host: "https://configured.youtrack.cloud/",
        token: "configured-token",
      });

      mockFetchOk(sampleIssue);
      await configuredTracker.getIssue("PROJ-123", project);

      expect(fetchMock.mock.calls[0][0]).toContain(
        "https://configured.youtrack.cloud/api/issues/PROJ-123",
      );
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
        "Bearer configured-token",
      );
    });
  });

  describe("getIssue", () => {
    it("returns Issue with correct fields", async () => {
      mockFetchOk(sampleIssue);
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.id).toBe("PROJ-123");
      expect(issue.title).toBe("Fix login bug");
      expect(issue.description).toBe("Users cannot log in with SSO.");
      expect(issue.state).toBe("in_progress");
      expect(issue.labels).toEqual(["agent:backlog"]);
      expect(issue.assignee).toBe("alice");
      expect(issue.priority).toBe(2); // Major
    });

    it("maps resolved issue to closed", async () => {
      mockFetchOk({ ...sampleIssue, resolved: 1700000000000 });
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.state).toBe("closed");
    });

    it("maps Done state to closed", async () => {
      mockFetchOk({
        ...sampleIssue,
        customFields: [
          {
            name: "State",
            $type: "StateIssueCustomField",
            value: { name: "Done", $type: "StateBundleElement" },
          },
        ],
      });
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.state).toBe("closed");
    });

    it("maps unresolved issue with no state to open", async () => {
      mockFetchOk({
        ...sampleIssue,
        customFields: [],
      });
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.state).toBe("open");
    });

    it("maps Critical priority to 1", async () => {
      mockFetchOk({
        ...sampleIssue,
        customFields: [
          ...sampleIssue.customFields.filter((f) => f.name !== "Priority"),
          {
            name: "Priority",
            $type: "SingleEnumIssueCustomField",
            value: { name: "Critical", $type: "EnumBundleElement" },
          },
        ],
      });
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.priority).toBe(1);
    });

    it("throws on API error", async () => {
      mockFetchError(404, "Not found");
      await expect(tracker.getIssue("PROJ-999", project)).rejects.toThrow("404");
    });
  });

  describe("isCompleted", () => {
    it("returns true when resolved is not null", async () => {
      mockFetchOk({ id: "2-123", resolved: 1700000000000, customFields: [] });
      expect(await tracker.isCompleted("PROJ-123", project)).toBe(true);
    });

    it("returns false when resolved is null", async () => {
      mockFetchOk({ id: "2-123", resolved: null, customFields: [] });
      expect(await tracker.isCompleted("PROJ-123", project)).toBe(false);
    });
  });

  describe("issueUrl", () => {
    it("generates correct URL", () => {
      expect(tracker.issueUrl("PROJ-123", project)).toBe(
        "https://mycompany.youtrack.cloud/issue/PROJ-123",
      );
    });
  });

  describe("issueLabel", () => {
    it("extracts issue ID from YouTrack URL", () => {
      expect(
        tracker.issueLabel(
          "https://mycompany.youtrack.cloud/issue/PROJ-123",
          project,
        ),
      ).toBe("PROJ-123");
    });

    it("returns full URL when pattern does not match", () => {
      const url = "https://example.com/something";
      expect(tracker.issueLabel(url, project)).toBe(url);
    });
  });

  describe("branchName", () => {
    it("generates correct branch name", () => {
      expect(tracker.branchName("PROJ-123", project)).toBe("feat/PROJ-123");
    });
  });

  describe("generatePrompt", () => {
    it("includes title, description, tags, and priority", async () => {
      mockFetchOk(sampleIssue);
      const prompt = await tracker.generatePrompt("PROJ-123", project);
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("Users cannot log in with SSO.");
      expect(prompt).toContain("Tags: agent:backlog");
      expect(prompt).toContain("Major");
    });
  });

  describe("listIssues", () => {
    it("returns mapped issues", async () => {
      mockFetchOk([sampleIssue]);
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe("PROJ-123");
    });

    it("filters by closed state", async () => {
      mockFetchOk([]);
      await tracker.listIssues!({ state: "closed" }, project);
      const url = fetchMock.mock.calls[0][0];
      expect(decodeURIComponent(url)).toContain("#Resolved");
    });

    it("filters by open state", async () => {
      mockFetchOk([]);
      await tracker.listIssues!({ state: "open" }, project);
      const url = fetchMock.mock.calls[0][0];
      expect(decodeURIComponent(url)).toContain("#Unresolved");
    });

    it("filters by labels via tag query syntax", async () => {
      mockFetchOk([]);
      await tracker.listIssues!(
        { state: "open", labels: ["agent:backlog"] },
        project,
      );
      const url = fetchMock.mock.calls[0][0] as string;
      expect(decodeURIComponent(url)).toContain("tag: {agent:backlog}");
    });

    it("returns empty labels when issue has no tags", async () => {
      mockFetchOk([{ ...sampleIssue, tags: [] }]);
      const issues = await tracker.listIssues!({}, project);
      expect(issues[0].labels).toEqual([]);
    });
  });

  describe("updateIssue", () => {
    it("updates state to closed via command API", async () => {
      mockFetchOk({}); // execute command
      await tracker.updateIssue!("PROJ-123", { state: "closed" }, project);
      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain("/api/commands");
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.query).toBe("State Resolved");
      expect(body.issues).toEqual([{ idReadable: "PROJ-123" }]);
    });

    it("updates state to in_progress via command API", async () => {
      mockFetchOk({}); // execute command
      await tracker.updateIssue!("PROJ-123", { state: "in_progress" }, project);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.query).toBe("State In Progress");
    });

    it("adds a comment", async () => {
      mockFetchOk({}); // POST comment
      await tracker.updateIssue!("PROJ-123", { comment: "Working on it" }, project);
      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain("/comments");
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.text).toBe("Working on it");
    });

    it("adds tags via unquoted tag commands", async () => {
      mockFetchOk({});
      await tracker.updateIssue!(
        "PROJ-123",
        { labels: ["agent:in-progress"] },
        project,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.query).toBe("tag agent:in-progress");
    });

    it("removes tags via remove-tag commands", async () => {
      mockFetchOk({});
      await tracker.updateIssue!(
        "PROJ-123",
        { removeLabels: ["agent:backlog"] },
        project,
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.query).toBe("remove tag agent:backlog");
    });

    it("supports adding and removing tags in a single update", async () => {
      mockFetchOk({}); // tag add
      mockFetchOk({}); // tag remove
      await tracker.updateIssue!(
        "PROJ-123",
        {
          labels: ["agent:in-progress"],
          removeLabels: ["agent:backlog"],
        },
        project,
      );
      const body1 = JSON.parse(fetchMock.mock.calls[0][1].body);
      const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body1.query).toBe("tag agent:in-progress");
      expect(body2.query).toBe("remove tag agent:backlog");
    });
  });

  describe("createIssue", () => {
    it("creates an issue", async () => {
      // First: resolve project
      mockFetchOk([{ id: "proj-internal", shortName: "PROJ", name: "Project" }]);
      // Second: create issue
      mockFetchOk(sampleIssue);
      const issue = await tracker.createIssue!(
        { title: "New bug", description: "Desc" },
        project,
      );
      expect(issue.id).toBe("PROJ-123");
    });

    it("throws when projectId is not in config", async () => {
      const badProject = {
        ...project,
        tracker: { plugin: "youtrack" },
      } as ProjectConfig;
      await expect(
        tracker.createIssue!({ title: "New" }, badProject),
      ).rejects.toThrow("projectId");
    });

    it("throws when project is not found in YouTrack", async () => {
      mockFetchOk([]); // no projects found
      await expect(
        tracker.createIssue!({ title: "New" }, project),
      ).rejects.toThrow("not found");
    });

    it("applies labels as separate tag commands after creation", async () => {
      mockFetchOk([{ id: "proj-internal", shortName: "PROJ", name: "Project" }]);
      mockFetchOk(sampleIssue);
      mockFetchOk({}); // tag command
      await tracker.createIssue!(
        { title: "New", description: "", labels: ["agent:backlog"] },
        project,
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const body = JSON.parse(fetchMock.mock.calls[2][1].body);
      expect(body.query).toBe("tag agent:backlog");
    });
  });

  describe("error handling", () => {
    it("throws when YOUTRACK_TOKEN is missing", async () => {
      vi.stubEnv("YOUTRACK_TOKEN", "");
      const trackerWithoutToken = create();
      await expect(trackerWithoutToken.getIssue("PROJ-123", project)).rejects.toThrow(
        "YOUTRACK_TOKEN",
      );
    });

    it("throws when YOUTRACK_HOST is missing", async () => {
      vi.stubEnv("YOUTRACK_HOST", "");
      const trackerWithoutHost = create();
      const noHostProject = {
        ...project,
        tracker: { plugin: "youtrack", projectId: "PROJ" },
      } as ProjectConfig;
      await expect(trackerWithoutHost.getIssue("PROJ-123", noHostProject)).rejects.toThrow(
        "YOUTRACK_HOST",
      );
    });
  });
});
