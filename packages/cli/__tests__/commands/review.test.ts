import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createActivitySignal,
  createInitialCanonicalLifecycle,
  createCodeReviewStore,
  type OrchestratorConfig,
  type Session,
  type SessionManager,
} from "@aoagents/ao-core";
import type * as AoCore from "@aoagents/ao-core";

const { mockConfigRef, mockSessionManager, reviewStoreRootRef } = vi.hoisted(() => ({
  mockConfigRef: { current: null as OrchestratorConfig | null },
  mockSessionManager: {
    get: vi.fn(),
    list: vi.fn(),
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    ensureOrchestrator: vi.fn(),
    restore: vi.fn(),
    kill: vi.fn(),
    cleanup: vi.fn(),
    send: vi.fn(),
    claimPR: vi.fn(),
  },
  reviewStoreRootRef: { current: "" },
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = await importOriginal<typeof AoCore>();
  const createIsolatedStore = (projectId: string, options: AoCore.CodeReviewStoreOptions = {}) =>
    actual.createCodeReviewStore(projectId, {
      ...options,
      storeDir: options.storeDir ?? `${reviewStoreRootRef.current}/${projectId}`,
    });

  return {
    ...actual,
    createCodeReviewStore: createIsolatedStore,
    triggerCodeReviewForSession: (
      options: AoCore.TriggerCodeReviewOptions,
      input: AoCore.TriggerCodeReviewInput,
    ) =>
      actual.triggerCodeReviewForSession(
        {
          ...options,
          storeFactory: options.storeFactory ?? createIsolatedStore,
        },
        input,
      ),
    executeCodeReviewRun: (
      options: AoCore.ExecuteCodeReviewRunOptions,
      input: AoCore.ExecuteCodeReviewRunInput,
    ) =>
      actual.executeCodeReviewRun(
        {
          ...options,
          storeFactory: options.storeFactory ?? createIsolatedStore,
        },
        input,
      ),
    sendCodeReviewFindingsToAgent: (
      options: AoCore.SendCodeReviewFindingsOptions,
      input: AoCore.SendCodeReviewFindingsInput,
    ) =>
      actual.sendCodeReviewFindingsToAgent(
        {
          ...options,
          storeFactory: options.storeFactory ?? createIsolatedStore,
        },
        input,
      ),
    loadConfig: () => mockConfigRef.current,
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as SessionManager,
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  const lifecycle = createInitialCanonicalLifecycle("worker", new Date("2026-05-10T10:00:00.000Z"));
  lifecycle.session.state = "idle";
  lifecycle.session.reason = "awaiting_external_review";
  lifecycle.pr.state = "open";
  lifecycle.pr.reason = "review_pending";
  lifecycle.pr.number = 7;
  lifecycle.pr.url = "https://github.com/acme/app/pull/7";
  lifecycle.runtime.state = "alive";
  lifecycle.runtime.reason = "process_running";

  return {
    id: "app-1",
    projectId: "app",
    status: "review_pending",
    activity: "idle",
    activitySignal: createActivitySignal("valid", {
      activity: "idle",
      timestamp: new Date("2026-05-10T10:00:00.000Z"),
      source: "native",
    }),
    lifecycle,
    branch: "feat/todos",
    issueId: null,
    pr: {
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      title: "feat: todos",
      owner: "acme",
      repo: "app",
      branch: "feat/todos",
      baseBranch: "main",
      isDraft: false,
    },
    workspacePath: null,
    runtimeHandle: { id: "tmux-app-1", runtimeName: "tmux", data: {} },
    agentInfo: null,
    createdAt: new Date("2026-05-10T09:00:00.000Z"),
    lastActivityAt: new Date("2026-05-10T10:00:00.000Z"),
    metadata: {},
    ...overrides,
  };
}

function createGitRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: path });
  writeFileSync(join(path, "README.md"), "# App\n");
  execFileSync("git", ["add", "README.md"], { cwd: path });
  execFileSync("git", ["commit", "-m", "initial"], {
    cwd: path,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "AO Test",
      GIT_AUTHOR_EMAIL: "ao@example.com",
      GIT_COMMITTER_NAME: "AO Test",
      GIT_COMMITTER_EMAIL: "ao@example.com",
    },
  });
}

let tmpDir: string;
let originalHome: string | undefined;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

import { Command } from "commander";
import { registerReview } from "../../src/commands/review.js";

let program: Command;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-cli-review-test-"));
  reviewStoreRootRef.current = join(tmpDir, "review-store");
  originalHome = process.env["HOME"];
  process.env["HOME"] = tmpDir;

  mockConfigRef.current = {
    configPath: join(tmpDir, "agent-orchestrator.yaml"),
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "codex", workspace: "worktree", notifiers: [] },
    projects: {
      app: {
        name: "App",
        path: join(tmpDir, "app"),
        defaultBranch: "main",
        sessionPrefix: "app",
      },
      docs: {
        name: "Docs",
        path: join(tmpDir, "docs"),
        defaultBranch: "main",
        sessionPrefix: "docs",
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
  };

  const appPath = join(tmpDir, "app");
  createGitRepo(appPath);
  createGitRepo(join(tmpDir, "docs"));

  mockSessionManager.get.mockReset();
  mockSessionManager.get.mockResolvedValue(makeSession({ workspacePath: appPath }));
  mockSessionManager.list.mockReset();
  mockSessionManager.send.mockReset();

  createCodeReviewStore("app").deleteAll();
  createCodeReviewStore("docs").deleteAll();

  program = new Command();
  program.exitOverride();
  registerReview(program);
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = originalHome;
  }
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("review command", () => {
  it("requests and lists review runs through the CLI", async () => {
    await program.parseAsync(["node", "test", "review", "run", "app-1", "--json"]);

    const runPayload = JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0])) as {
      run: { linkedSessionId: string; reviewerSessionId: string; status: string };
    };
    expect(runPayload.run).toMatchObject({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "queued",
    });

    consoleLogSpy.mockClear();
    await program.parseAsync(["node", "test", "review", "list", "app", "--json"]);

    const listPayload = JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0])) as {
      runs: Array<{ linkedSessionId: string; reviewerSessionId: string }>;
    };
    expect(listPayload.runs).toHaveLength(1);
    expect(listPayload.runs[0]).toMatchObject({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
    });
  });

  it("rejects unknown review run statuses", async () => {
    await expect(
      program.parseAsync(["node", "test", "review", "run", "app-1", "--status", "bogus"]),
    ).rejects.toThrow("process.exit(1)");
  });

  it("can request and execute a review run directly", async () => {
    await program.parseAsync([
      "node",
      "test",
      "review",
      "run",
      "app-1",
      "--execute",
      "--command",
      `printf '%s\\n' '{"findings":[{"severity":"warning","title":"CLI finding","body":"Detected in CLI."}]}'`,
      "--json",
    ]);

    const payload = JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0])) as {
      run: { status: string; findingCount: number; openFindingCount: number };
    };
    expect(payload.run).toMatchObject({
      status: "needs_triage",
      findingCount: 1,
      openFindingCount: 1,
    });
  });

  it("executes the oldest queued review run across all projects when no run is specified", async () => {
    const appStore = createCodeReviewStore("app");
    const docsStore = createCodeReviewStore("docs");
    const appPath = join(tmpDir, "app");
    const docsPath = join(tmpDir, "docs");
    mockSessionManager.get.mockImplementation(async (sessionId: string) => {
      if (sessionId === "docs-1") {
        return makeSession({ id: "docs-1", projectId: "docs", workspacePath: docsPath });
      }
      if (sessionId === "app-1") {
        return makeSession({ id: "app-1", projectId: "app", workspacePath: appPath });
      }
      return null;
    });
    const older = docsStore.createRun(
      {
        linkedSessionId: "docs-1",
        reviewerSessionId: "docs-rev-1",
        status: "queued",
      },
      new Date("2026-05-10T10:00:00.000Z"),
    );
    const newer = appStore.createRun(
      {
        linkedSessionId: "app-1",
        reviewerSessionId: "app-rev-1",
        status: "queued",
      },
      new Date("2026-05-10T11:00:00.000Z"),
    );

    await program.parseAsync([
      "node",
      "test",
      "review",
      "execute",
      "--command",
      `printf '%s\\n' '{"findings":[]}'`,
      "--json",
    ]);

    const payload = JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0])) as {
      run: { id: string; reviewerSessionId: string; status: string };
    };
    expect(payload.run).toMatchObject({
      id: older.id,
      reviewerSessionId: "docs-rev-1",
      status: "clean",
    });
    expect(createCodeReviewStore("app").getRun(newer.id)?.status).toBe("queued");
  });

  it("sends open review findings to the linked coding worker", async () => {
    const store = createCodeReviewStore("app");
    const run = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "needs_triage",
      prNumber: 7,
    });
    store.createFinding({
      runId: run.id,
      linkedSessionId: "app-1",
      severity: "warning",
      title: "CLI finding",
      body: "Detected in CLI.",
      filePath: "src/app.ts",
      startLine: 12,
    });

    await program.parseAsync([
      "node",
      "test",
      "review",
      "send",
      "app-rev-1",
      "--project",
      "app",
      "--json",
    ]);

    const payload = JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0])) as {
      run: { status: string; openFindingCount: number; sentFindingCount: number };
      sentFindingCount: number;
      message: string;
    };
    expect(payload).toMatchObject({
      sentFindingCount: 1,
      run: {
        status: "waiting_update",
        openFindingCount: 0,
        sentFindingCount: 1,
      },
    });
    expect(payload.message).toContain("AO reviewer app-rev-1 found 1 open issue");
    expect(payload.message).toContain("Location: src/app.ts:12");
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "app-1",
      expect.stringContaining("[warning] CLI finding"),
    );
  });
});
