import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { recoverSessionById, runRecovery } from "../recovery/manager.js";
import { recordActivityEvent } from "../activity-events.js";
import { getProjectDir, getProjectSessionsDir } from "../paths.js";
import {
  DEFAULT_RECOVERY_CONFIG,
  type RecoveryAssessment,
  type RecoveryResult,
} from "../recovery/types.js";
import * as actionsModule from "../recovery/actions.js";
import * as validatorModule from "../recovery/validator.js";
import type { OrchestratorConfig, PluginRegistry } from "../types.js";

vi.mock("../activity-events.js", () => ({
  recordActivityEvent: vi.fn(),
}));

const PROJECT_ID = "app";

function makeConfig(rootDir: string): OrchestratorConfig {
  return {
    configPath: join(rootDir, "agent-orchestrator.yaml"),
    port: 3000,
    readyThresholdMs: 300_000,
    power: { preventIdleSleep: false },
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {
      app: {
        name: "app",
        repo: "org/repo",
        path: join(rootDir, "project"),
        defaultBranch: "main",
        sessionPrefix: "app",
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: ["desktop"],
      info: ["desktop"],
    },
    reactions: {},
  };
}

function makeRegistry(): PluginRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn().mockResolvedValue(undefined),
    loadFromConfig: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAssessment(sessionId: string): RecoveryAssessment {
  return {
    sessionId,
    projectId: PROJECT_ID,
    classification: "live",
    action: "recover",
    reason: "needs recovery",
    runtimeProbeSucceeded: true,
    processProbeSucceeded: true,
    signalDisagreement: false,
    recoveryRule: "auto",
    runtimeAlive: true,
    runtimeHandle: null,
    workspaceExists: true,
    workspacePath: "/tmp/worktree",
    agentProcessRunning: true,
    agentActivity: "active",
    metadataValid: true,
    metadataStatus: "working",
    rawMetadata: { project: PROJECT_ID, status: "working" },
  };
}

describe("runRecovery activity events", () => {
  let rootDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    rootDir = join(tmpdir(), `ao-recovery-events-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");
    previousHome = process.env["HOME"];
    process.env["HOME"] = rootDir;

    const sessionsDir = getProjectSessionsDir(PROJECT_ID);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "app-1.json"),
      JSON.stringify({ project: PROJECT_ID, status: "working" }) + "\n",
      "utf-8",
    );
    writeFileSync(
      join(sessionsDir, "app-2.json"),
      JSON.stringify({ project: PROJECT_ID, status: "working" }) + "\n",
      "utf-8",
    );

    vi.mocked(recordActivityEvent).mockClear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = previousHome;
    }
    if (rootDir) {
      const projectBaseDir = getProjectDir(PROJECT_ID);
      if (existsSync(projectBaseDir)) {
        rmSync(projectBaseDir, { recursive: true, force: true });
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("emits recovery.session_failed for each session that recovery couldn't fix", async () => {
    vi.spyOn(validatorModule, "validateSession").mockImplementation(async (scanned) =>
      makeAssessment(scanned.sessionId),
    );

    const successResult: RecoveryResult = {
      success: true,
      sessionId: "app-1",
      action: "recover",
    };
    const failedResult: RecoveryResult = {
      success: false,
      sessionId: "app-2",
      action: "recover",
      error: "worktree missing",
    };

    vi.spyOn(actionsModule, "executeAction")
      .mockResolvedValueOnce(successResult)
      .mockResolvedValueOnce(failedResult);

    const config = makeConfig(rootDir);
    const registry = makeRegistry();

    const { report } = await runRecovery({
      config,
      registry,
      recoveryConfig: {
        ...DEFAULT_RECOVERY_CONFIG,
        logPath: join(rootDir, "recovery.log"),
      },
    });

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.sessionId).toBe("app-2");

    const emitCalls = vi
      .mocked(recordActivityEvent)
      .mock.calls.map((c) => c[0])
      .filter((e) => e.kind === "recovery.session_failed");

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0]).toEqual(
      expect.objectContaining({
        sessionId: "app-2",
        projectId: PROJECT_ID,
        source: "recovery",
        kind: "recovery.session_failed",
        level: "error",
        data: expect.objectContaining({
          action: "recover",
          errorMessage: "worktree missing",
        }),
      }),
    );
  });

  it("emits recovery.session_failed when single-session recovery fails", async () => {
    vi.spyOn(validatorModule, "validateSession").mockImplementation(async (scanned) =>
      makeAssessment(scanned.sessionId),
    );

    const failedResult: RecoveryResult = {
      success: false,
      sessionId: "app-2",
      action: "recover",
      error: "agent process missing",
    };

    vi.spyOn(actionsModule, "executeAction").mockResolvedValueOnce(failedResult);

    const config = makeConfig(rootDir);
    const registry = makeRegistry();

    const result = await recoverSessionById("app-2", {
      config,
      registry,
      recoveryConfig: {
        ...DEFAULT_RECOVERY_CONFIG,
        logPath: join(rootDir, "recovery.log"),
      },
    });

    expect(result).toEqual(failedResult);

    const emitCalls = vi
      .mocked(recordActivityEvent)
      .mock.calls.map((c) => c[0])
      .filter((e) => e.kind === "recovery.session_failed");

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0]).toEqual(
      expect.objectContaining({
        sessionId: "app-2",
        projectId: PROJECT_ID,
        source: "recovery",
        kind: "recovery.session_failed",
        level: "error",
        data: expect.objectContaining({
          action: "recover",
          errorMessage: "agent process missing",
        }),
      }),
    );
  });

  it("does not emit recovery.session_failed when every session recovers cleanly", async () => {
    vi.spyOn(validatorModule, "validateSession").mockImplementation(async (scanned) =>
      makeAssessment(scanned.sessionId),
    );

    vi.spyOn(actionsModule, "executeAction").mockImplementation(async (assessment) => ({
      success: true,
      sessionId: assessment.sessionId,
      action: "recover",
    }));

    const config = makeConfig(rootDir);
    const registry = makeRegistry();

    await runRecovery({
      config,
      registry,
      recoveryConfig: {
        ...DEFAULT_RECOVERY_CONFIG,
        logPath: join(rootDir, "recovery.log"),
      },
    });

    const failedEmits = vi
      .mocked(recordActivityEvent)
      .mock.calls.map((c) => c[0])
      .filter((e) => e.kind === "recovery.session_failed");
    expect(failedEmits).toHaveLength(0);
  });
});
