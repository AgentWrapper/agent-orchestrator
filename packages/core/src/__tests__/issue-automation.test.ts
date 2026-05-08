import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActivitySignal, createInitialCanonicalLifecycle } from "../index.js";
import { pollIssueAutomationProject } from "../issue-automation.js";
import type { Issue, OpenCodeSessionManager, ProjectConfig, Session, Tracker } from "../types.js";

const project: ProjectConfig = {
  name: "App",
  repo: "owner/repo",
  path: "/tmp/app",
  defaultBranch: "main",
  sessionPrefix: "app",
  tracker: { plugin: "github" },
  issueAutomation: {
    enabled: true,
    triggerLabel: "ao:auto",
    spawnedLabel: "ao:spawned",
  },
};

function makeIssue(overrides: Partial<Issue>): Issue {
  return {
    id: "1",
    title: "Issue",
    description: "",
    url: "https://github.com/owner/repo/issues/1",
    state: "open",
    labels: ["ao:auto"],
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session>): Session {
  const lifecycle = createInitialCanonicalLifecycle("worker", new Date());
  lifecycle.session.state = "working";
  lifecycle.runtime.state = "alive";
  return {
    id: "app-1",
    projectId: "app",
    status: "working",
    activity: "active",
    activitySignal: createActivitySignal("valid", {
      activity: "active",
      source: "native",
      timestamp: new Date(),
    }),
    lifecycle,
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeHarness(issues: Issue[], sessions: Session[] = []) {
  const tracker = {
    name: "github",
    listIssues: vi.fn(async () => issues),
    updateIssue: vi.fn(async () => undefined),
  } as unknown as Tracker;
  const sessionManager = {
    list: vi.fn(async () => sessions),
    spawn: vi.fn(async ({ projectId, issueId }) =>
      makeSession({ id: `${projectId}-2`, projectId, issueId: issueId ?? null }),
    ),
  } as unknown as OpenCodeSessionManager;
  return { tracker, sessionManager };
}

describe("pollIssueAutomationProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores issues missing the trigger label", async () => {
    const { tracker, sessionManager } = makeHarness([makeIssue({ labels: ["bug"] })]);

    const result = await pollIssueAutomationProject({
      projectId: "app",
      project,
      tracker,
      sessionManager,
    });

    expect(result.spawned).toBe(0);
    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  it("ignores issues already marked spawned", async () => {
    const { tracker, sessionManager } = makeHarness([
      makeIssue({ labels: ["ao:auto", "ao:spawned"] }),
    ]);

    await pollIssueAutomationProject({ projectId: "app", project, tracker, sessionManager });

    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  it("skips when an active session already exists for the issue", async () => {
    const { tracker, sessionManager } = makeHarness(
      [makeIssue({ id: "42" })],
      [makeSession({ issueId: "42" })],
    );

    await pollIssueAutomationProject({ projectId: "app", project, tracker, sessionManager });

    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  it("spawns and marks the spawned label after success", async () => {
    const { tracker, sessionManager } = makeHarness([makeIssue({ id: "42" })]);

    const result = await pollIssueAutomationProject({
      projectId: "app",
      project,
      tracker,
      sessionManager,
    });

    expect(result.spawned).toBe(1);
    expect(sessionManager.spawn).toHaveBeenCalledWith({ projectId: "app", issueId: "42" });
    expect(tracker.updateIssue).toHaveBeenCalledWith("42", { labels: ["ao:spawned"] }, project);
  });
});
