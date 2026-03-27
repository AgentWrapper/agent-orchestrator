import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { create, manifest } from "../index.js";

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------
const fetchMock = vi.fn() as Mock;
vi.stubGlobal("fetch", fetchMock);

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "application/json"]]),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

const project = {
  repo: "myws/myrepo",
  path: "/tmp/myrepo",
  defaultBranch: "main",
  tracker: { plugin: "jira", domain: "mycompany", projectKey: "PROJ" },
} as never;

beforeEach(() => {
  vi.stubEnv("JIRA_DOMAIN", "mycompany");
  vi.stubEnv("JIRA_EMAIL", "test@example.com");
  vi.stubEnv("JIRA_API_TOKEN", "test-token");
  fetchMock.mockReset();
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("manifest", () => {
  it("has correct name and slot", () => {
    expect(manifest.name).toBe("jira");
    expect(manifest.slot).toBe("tracker");
  });
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe("create", () => {
  it("returns a Tracker with required methods", () => {
    const tracker = create({ domain: "mycompany" });
    expect(tracker.name).toBe("jira");
    expect(typeof tracker.getIssue).toBe("function");
    expect(typeof tracker.isCompleted).toBe("function");
    expect(typeof tracker.issueUrl).toBe("function");
    expect(typeof tracker.branchName).toBe("function");
    expect(typeof tracker.generatePrompt).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Helpers for mock responses
// ---------------------------------------------------------------------------

function jiraIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "10001",
    key: "PROJ-123",
    self: "https://mycompany.atlassian.net/rest/api/3/issue/10001",
    fields: {
      summary: "Fix the bug",
      description: {
        type: "doc",
        version: 1,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Description text here" }] },
        ],
      },
      status: {
        id: "3",
        name: "In Progress",
        statusCategory: { id: 4, key: "indeterminate", name: "In Progress" },
      },
      issuetype: { id: "10001", name: "Story" },
      priority: { id: "3", name: "Medium" },
      labels: ["backend", "urgent"],
      assignee: {
        accountId: "abc123",
        displayName: "Alice Smith",
        emailAddress: "alice@example.com",
      },
      project: { key: "PROJ", name: "My Project" },
      created: "2026-01-01T00:00:00.000+0000",
      updated: "2026-01-15T00:00:00.000+0000",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getIssue
// ---------------------------------------------------------------------------

describe("getIssue", () => {
  it("maps Jira issue to core Issue type", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(jiraIssue()));

    const tracker = create({ domain: "mycompany" });
    const issue = await tracker.getIssue("PROJ-123", project);

    expect(issue.id).toBe("PROJ-123");
    expect(issue.title).toBe("Fix the bug");
    expect(issue.description).toContain("Description text here");
    expect(issue.state).toBe("in_progress");
    expect(issue.labels).toEqual(["backend", "urgent"]);
    expect(issue.assignee).toBe("Alice Smith");
    expect(issue.priority).toBe(3);
    expect(issue.url).toBe("https://mycompany.atlassian.net/browse/PROJ-123");
  });

  it("handles done status", async () => {
    const done = jiraIssue();
    (done.fields as Record<string, unknown>).status = {
      id: "5",
      name: "Done",
      statusCategory: { id: 3, key: "done", name: "Done" },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(done));

    const tracker = create({ domain: "mycompany" });
    const issue = await tracker.getIssue("PROJ-456", project);
    expect(issue.state).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// isCompleted
// ---------------------------------------------------------------------------

describe("isCompleted", () => {
  it("returns true when status category is done", async () => {
    const done = jiraIssue();
    (done.fields as Record<string, unknown>).status = {
      id: "5",
      name: "Done",
      statusCategory: { id: 3, key: "done", name: "Done" },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(done));

    const tracker = create({ domain: "mycompany" });
    expect(await tracker.isCompleted("PROJ-123", project)).toBe(true);
  });

  it("returns false when status category is not done", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(jiraIssue()));

    const tracker = create({ domain: "mycompany" });
    expect(await tracker.isCompleted("PROJ-123", project)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// issueUrl / issueLabel / branchName
// ---------------------------------------------------------------------------

describe("issueUrl", () => {
  it("generates correct URL", () => {
    const tracker = create({ domain: "mycompany" });
    expect(tracker.issueUrl("PROJ-123", project)).toBe(
      "https://mycompany.atlassian.net/browse/PROJ-123",
    );
  });

  it("handles full domain", () => {
    const tracker = create({ domain: "mycompany.atlassian.net" });
    expect(tracker.issueUrl("PROJ-123", project)).toBe(
      "https://mycompany.atlassian.net/browse/PROJ-123",
    );
  });
});

describe("issueLabel", () => {
  it("extracts key from URL", () => {
    const tracker = create({ domain: "mycompany" });
    expect(tracker.issueLabel!("https://mycompany.atlassian.net/browse/PROJ-123", project)).toBe(
      "PROJ-123",
    );
  });
});

describe("branchName", () => {
  it("generates feat/KEY branch name", () => {
    const tracker = create({ domain: "mycompany" });
    expect(tracker.branchName("PROJ-123", project)).toBe("feat/PROJ-123");
  });
});

// ---------------------------------------------------------------------------
// generatePrompt
// ---------------------------------------------------------------------------

describe("generatePrompt", () => {
  it("generates prompt with issue details", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(jiraIssue()));

    const tracker = create({ domain: "mycompany" });
    const prompt = await tracker.generatePrompt("PROJ-123", project);

    expect(prompt).toContain("PROJ-123");
    expect(prompt).toContain("Fix the bug");
    expect(prompt).toContain("Description text here");
    expect(prompt).toContain("mycompany.atlassian.net/browse/PROJ-123");
  });
});

// ---------------------------------------------------------------------------
// listIssues
// ---------------------------------------------------------------------------

describe("listIssues", () => {
  it("builds JQL from filters", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        startAt: 0,
        maxResults: 30,
        total: 1,
        issues: [jiraIssue()],
      }),
    );

    const tracker = create({ domain: "mycompany", projectKey: "PROJ" });
    const issues = await tracker.listIssues!(
      { state: "open", labels: ["backend"], limit: 10 },
      project,
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe("PROJ-123");

    // Verify JQL was sent
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.jql).toContain('project = "PROJ"');
    expect(body.jql).toContain('statusCategory != "Done"');
    expect(body.jql).toContain('labels in ("backend")');
    expect(body.maxResults).toBe(10);
  });

  it("escapes JQL special characters in filter values to prevent injection", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        startAt: 0,
        maxResults: 30,
        total: 0,
        issues: [],
      }),
    );

    const tracker = create({ domain: "mycompany", projectKey: "PROJ" });
    await tracker.listIssues!(
      {
        state: "open",
        labels: ['label"with"quotes'],
        assignee: 'user" OR project = "SECRET',
      },
      project,
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Quotes must be escaped — no JQL breakout
    expect(body.jql).toContain('labels in ("label\\"with\\"quotes")');
    expect(body.jql).toContain('assignee = "user\\" OR project = \\"SECRET"');
    // The injected clause should NOT appear as a separate JQL clause
    expect(body.jql).not.toMatch(/AND project = "SECRET"/);
  });
});

// ---------------------------------------------------------------------------
// updateIssue — transitions
// ---------------------------------------------------------------------------

describe("updateIssue", () => {
  it("executes a transition to close an issue", async () => {
    // GET transitions
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        transitions: [
          {
            id: "31",
            name: "Done",
            to: {
              id: "5",
              name: "Done",
              statusCategory: { id: 3, key: "done", name: "Done" },
            },
            hasScreen: false,
          },
        ],
      }),
    );
    // POST transition
    fetchMock.mockResolvedValueOnce(jsonResponse(null, 204));

    const tracker = create({ domain: "mycompany" });
    await tracker.updateIssue!("PROJ-123", { state: "closed" }, project);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const transitionBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(transitionBody.transition.id).toBe("31");
  });

  it("posts a comment when provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "comment-1" }));

    const tracker = create({ domain: "mycompany" });
    await tracker.updateIssue!("PROJ-123", { comment: "Hello from AO" }, project);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.body.type).toBe("doc");
    expect(body.body.content[0].content[0].text).toBe("Hello from AO");
  });
});
