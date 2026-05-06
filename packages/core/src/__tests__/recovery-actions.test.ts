import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readMetadataRaw } from "../metadata.js";
import { getProjectSessionsDir, getProjectDir } from "../paths.js";
import { cleanupSession, escalateSession, recoverSession } from "../recovery/actions.js";
import { runRecovery } from "../recovery/manager.js";
import { getRecoveryLogPath, scanAllSessions } from "../recovery/scanner.js";
import {
  DEFAULT_RECOVERY_CONFIG,
  type RecoveryAssessment,
  type RecoveryContext,
} from "../recovery/types.js";
import type { OrchestratorConfig, PluginRegistry, Runtime, Workspace } from "../types.js";

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

function makeAssessment(overrides: Partial<RecoveryAssessment> = {}): RecoveryAssessment {
  return {
    sessionId: "app-1",
    projectId: "app",
    classification: "live",
    action: "recover",
    reason: "Session is running normally",
    runtimeProbeSucceeded: true,
    processProbeSucceeded: true,
    signalDisagreement: false,
    recoveryRule: "auto",
    runtimeAlive: true,
    runtimeHandle: { id: "rt-1", runtimeName: "tmux", data: {} },
    workspaceExists: true,
    workspacePath: "/tmp/worktree",
    agentProcessRunning: true,
    agentActivity: "active",
    metadataValid: true,
    metadataStatus: "working",
    rawMetadata: {
      project: "app",
      branch: "feat/test",
      issue: "123",
      pr: "https://github.com/org/repo/pull/42",
      createdAt: "2025-01-01T00:00:00.000Z",
      status: "working",
      summary: "Recovered summary",
    },
    ...overrides,
  };
}

function makeContext(rootDir: string, overrides: Partial<RecoveryContext> = {}): RecoveryContext {
  return {
    configPath: join(rootDir, "agent-orchestrator.yaml"),
    recoveryConfig: {
      ...DEFAULT_RECOVERY_CONFIG,
      logPath: join(rootDir, "recovery.log"),
    },
    dryRun: false,
    ...overrides,
  };
}

describe("recoverSession", () => {
  let rootDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");
    previousHome = process.env["HOME"];
    process.env["HOME"] = rootDir;
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
  });

  it("persists restoredAt and returns a session with restoredAt", async () => {

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment();
    const context = makeContext(rootDir);

    const result = await recoverSession(assessment, config, registry, context);
    const sessionsDir = getProjectSessionsDir(PROJECT_ID);
    const metadata = readMetadataRaw(sessionsDir, assessment.sessionId);

    expect(result.success).toBe(true);
    expect(result.session?.restoredAt).toBeInstanceOf(Date);
    expect(metadata?.["restoredAt"]).toBeDefined();
    expect(metadata?.["recoveredAt"]).toBeUndefined();
  });

  it("preserves project ownership when legacy metadata omits the project field", async () => {
    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      rawMetadata: {
        branch: "feature/recover",
        worktree: join(rootDir, "project"),
        status: "needs_input",
      },
    });
    const context = makeContext(rootDir);

    const result = await recoverSession(assessment, config, registry, context);

    expect(result.success).toBe(true);
    expect(result.session?.projectId).toBe("app");
  });

  it("returns the max-attempt reason when recovery escalates", async () => {
    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      rawMetadata: {
        ...makeAssessment().rawMetadata,
        recoveryCount: "3",
      },
    });
    const context = makeContext(rootDir, {
      recoveryConfig: {
        ...DEFAULT_RECOVERY_CONFIG,
        logPath: join(rootDir, "recovery.log"),
        maxRecoveryAttempts: 3,
      },
    });

    const result = await recoverSession(assessment, config, registry, context);

    expect(result.success).toBe(true);
    expect(result.action).toBe("escalate");
    expect(result.reason).toBe("Exceeded max recovery attempts (3)");
  });

  it("dry-run recovery reports escalate when attempts exceed limit", async () => {
    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      rawMetadata: {
        ...makeAssessment().rawMetadata,
        recoveryCount: "3",
      },
    });
    const context = makeContext(rootDir, {
      dryRun: true,
      recoveryConfig: {
        ...DEFAULT_RECOVERY_CONFIG,
        logPath: join(rootDir, "recovery.log"),
        maxRecoveryAttempts: 3,
      },
    });

    const result = await recoverSession(assessment, config, registry, context);

    expect(result.success).toBe(true);
    expect(result.action).toBe("escalate");
    expect(result.requiresManualIntervention).toBe(true);
    expect(result.reason).toBe("Exceeded max recovery attempts (3)");
  });

  it("calls context.invalidateCache() after mutating metadata", async () => {
    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment();
    const invalidateCache = vi.fn();
    const context = makeContext(rootDir, { invalidateCache });

    await recoverSession(assessment, config, registry, context);

    expect(invalidateCache).toHaveBeenCalled();
  });
});

describe("escalateSession", () => {
  let rootDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");
    previousHome = process.env["HOME"];
    process.env["HOME"] = rootDir;
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
  });

  it("uses the assessment reason during dry runs", async () => {
    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      action: "escalate",
      classification: "partial",
      reason: "Workspace exists but runtime is missing",
    });
    const context = makeContext(rootDir, { dryRun: true });

    const result = await escalateSession(assessment, config, registry, context);

    expect(result.success).toBe(true);
    expect(result.action).toBe("escalate");
    expect(result.reason).toBe("Workspace exists but runtime is missing");
  });
});

describe("cleanupSession", () => {
  let rootDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");
    previousHome = process.env["HOME"];
    process.env["HOME"] = rootDir;
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
  });

  it("continues cleanup and marks session terminated even when workspace.destroy throws", async () => {
    const config = makeConfig(rootDir);
    const workspacePath = join(rootDir, "worktree");
    const mockWorkspace: Workspace = {
      name: "worktree",
      create: vi.fn(),
      destroy: vi.fn().mockRejectedValue(new Error("Workspace destroy failed")),
      list: vi.fn(),
      exists: vi.fn(),
    };
    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };
    const assessment = makeAssessment({
      action: "cleanup",
      classification: "dead",
      runtimeAlive: false,
      workspaceExists: true,
      workspacePath,
      rawMetadata: {
        ...makeAssessment().rawMetadata,
        worktree: workspacePath,
      },
    });
    const context = makeContext(rootDir);

    const result = await cleanupSession(assessment, config, registry, context);
    const sessionsDir = getProjectSessionsDir(PROJECT_ID);

    expect(mockWorkspace.destroy).toHaveBeenCalled();
    expect(result.success).toBe(true);
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta).not.toBeNull();
    expect(meta!["status"]).toBe("terminated");
    expect(meta!["terminationReason"]).toBe("cleanup");
  });

  it("continues cleanup and marks session terminated even when runtime.destroy throws", async () => {
    const config = makeConfig(rootDir);
    const workspacePath = join(rootDir, "worktree");
    const mockRuntime: Runtime = {
      name: "tmux",
      create: vi.fn(),
      destroy: vi.fn().mockRejectedValue(new Error("Runtime destroy failed")),
      sendMessage: vi.fn(),
      getOutput: vi.fn(),
      isAlive: vi.fn(),
    };
    const mockWorkspace: Workspace = {
      name: "worktree",
      create: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
      list: vi.fn(),
      exists: vi.fn(),
    };
    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };
    const assessment = makeAssessment({
      action: "cleanup",
      classification: "partial",
      runtimeAlive: true,
      workspaceExists: true,
      workspacePath,
      rawMetadata: {
        ...makeAssessment().rawMetadata,
        worktree: workspacePath,
      },
    });
    const context = makeContext(rootDir);

    const result = await cleanupSession(assessment, config, registry, context);
    const sessionsDir = getProjectSessionsDir(PROJECT_ID);

    expect(mockRuntime.destroy).toHaveBeenCalled();
    expect(mockWorkspace.destroy).toHaveBeenCalled();
    expect(result.success).toBe(true);
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta).not.toBeNull();
    expect(meta!["status"]).toBe("terminated");
    expect(meta!["terminationReason"]).toBe("cleanup");
  });
});

// Regression for the boundary-bug-hunter Phase 2 finding on PR #1466:
// Recovery actions used to write a flat `status` field, but for V2
// lifecycle-backed sessions `readMetadataRaw()` overrides flat `status`
// with `deriveLegacyStatus(lifecycle)`. So a cleanup or escalation that
// only mutated the flat field was silently overridden on the next read.
// The fix updates the lifecycle object alongside the flat field.
describe("recovery actions update lifecycle for V2 sessions", () => {
  let rootDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    rootDir = join(tmpdir(), `ao-recovery-lifecycle-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");
    previousHome = process.env["HOME"];
    process.env["HOME"] = rootDir;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    if (rootDir) {
      const projectBaseDir = getProjectDir(PROJECT_ID);
      if (existsSync(projectBaseDir)) rmSync(projectBaseDir, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  function v2LifecycleString(state: string, reason: string): string {
    return JSON.stringify({
      version: 2,
      session: {
        kind: "worker",
        state,
        reason,
        startedAt: "2026-04-28T10:00:00.000Z",
        completedAt: null,
        terminatedAt: null,
        lastTransitionAt: "2026-04-28T10:00:00.000Z",
      },
      pr: { state: "none", reason: "no_pr", url: null, number: null, lastTransitionAt: "2026-04-28T10:00:00.000Z" },
      runtime: { state: "alive", reason: "spawned", handle: null, tmuxName: null, lastTransitionAt: "2026-04-28T10:00:00.000Z" },
    });
  }

  it("cleanupSession writes lifecycle.session.state = terminated for V2 sessions", async () => {
    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      rawMetadata: {
        project: "app",
        branch: "feat/x",
        status: "working",
        lifecycle: v2LifecycleString("working", "task_in_progress"),
      },
    });
    const context = makeContext(rootDir);

    const result = await cleanupSession(assessment, config, registry, context);
    expect(result.success).toBe(true);

    const sessionsDir = getProjectSessionsDir(PROJECT_ID);
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta).not.toBeNull();
    // For V2 sessions the flat status is derived from the lifecycle on
    // read. `state=terminated` + `reason=auto_cleanup` maps to the legacy
    // status "cleanup" (see deriveLegacyStatus). The pre-fix bug was that
    // the lifecycle wasn't updated at all, so this would have read back as
    // "working" — the lifecycle state of the prior phase.
    expect(meta!["status"]).toBe("cleanup");

    const persistedLifecycle = JSON.parse(meta!["lifecycle"]) as {
      session: { state: string; reason: string; terminatedAt: string | null };
    };
    expect(persistedLifecycle.session.state).toBe("terminated");
    expect(persistedLifecycle.session.reason).toBe("auto_cleanup");
    expect(persistedLifecycle.session.terminatedAt).toBeTruthy();
  });

  it("escalateSession writes lifecycle.session.state = stuck for V2 sessions", async () => {
    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      action: "escalate",
      reason: "Probe failed three times",
      rawMetadata: {
        project: "app",
        branch: "feat/x",
        status: "working",
        lifecycle: v2LifecycleString("working", "task_in_progress"),
      },
    });
    const context = makeContext(rootDir);

    const result = await escalateSession(assessment, config, registry, context);
    expect(result.success).toBe(true);

    const sessionsDir = getProjectSessionsDir(PROJECT_ID);
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["status"]).toBe("stuck");

    const persistedLifecycle = JSON.parse(meta!["lifecycle"]) as {
      session: { state: string; reason: string };
    };
    expect(persistedLifecycle.session.state).toBe("stuck");
    expect(persistedLifecycle.session.reason).toBe("probe_failure");
  });

  it("recoverSession writes lifecycle.session.state = stuck when max attempts exceeded", async () => {
    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      rawMetadata: {
        project: "app",
        branch: "feat/x",
        status: "working",
        recoveryCount: "3",
        lifecycle: v2LifecycleString("working", "task_in_progress"),
      },
    });
    const context = makeContext(rootDir, {
      recoveryConfig: {
        ...DEFAULT_RECOVERY_CONFIG,
        logPath: join(rootDir, "recovery.log"),
        maxRecoveryAttempts: 3,
      },
    });

    const result = await recoverSession(assessment, config, registry, context);
    expect(result.action).toBe("escalate");

    const sessionsDir = getProjectSessionsDir(PROJECT_ID);
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["status"]).toBe("stuck");

    const persistedLifecycle = JSON.parse(meta!["lifecycle"]) as {
      session: { state: string; reason: string };
    };
    expect(persistedLifecycle.session.state).toBe("stuck");
    expect(persistedLifecycle.session.reason).toBe("probe_failure");
  });

  it("does not add a lifecycle field to legacy (pre-V2) sessions", async () => {
    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      rawMetadata: {
        project: "app",
        branch: "feat/x",
        status: "working",
        // no `lifecycle` and no V2 statePayload — legacy session
      },
    });
    const context = makeContext(rootDir);

    await cleanupSession(assessment, config, registry, context);

    const sessionsDir = getProjectSessionsDir(PROJECT_ID);
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["status"]).toBe("terminated");
    expect(meta!["lifecycle"]).toBeUndefined();
  });
});

describe("recovery manager and scanner", () => {
  let rootDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");
    previousHome = process.env["HOME"];
    process.env["HOME"] = rootDir;
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
  });

  it("respects custom recovery logPath in manager options", async () => {
    const config = makeConfig(rootDir);
    const sessionsDir = getProjectSessionsDir(PROJECT_ID);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "app-1.json"),
      JSON.stringify({ project: "app", status: "terminated", worktree: "/tmp/worktree" }, null, 2) + "\n",
      "utf-8",
    );

    const customLogPath = join(rootDir, "custom-recovery.log");
    const registry = makeRegistry();

    await runRecovery({
      config,
      registry,
      recoveryConfig: {
        ...DEFAULT_RECOVERY_CONFIG,
        logPath: customLogPath,
      },
    });

    expect(existsSync(customLogPath)).toBe(true);
    expect(readFileSync(customLogPath, "utf-8")).toContain('"sessionId":"app-1"');

    const defaultLogPath = getRecoveryLogPath(config.configPath);
    expect(defaultLogPath).not.toBe(customLogPath);
  });

  it("scans sessions using metadata listing rules", () => {
    const config = makeConfig(rootDir);
    const sessionsDir = getProjectSessionsDir(PROJECT_ID);
    mkdirSync(sessionsDir, { recursive: true });

    writeFileSync(join(sessionsDir, "app-1.json"), JSON.stringify({ project: "app", status: "working" }, null, 2) + "\n", "utf-8");
    writeFileSync(join(sessionsDir, ".tmp"), JSON.stringify({ project: "app" }, null, 2) + "\n", "utf-8");
    writeFileSync(join(sessionsDir, "bad.session"), JSON.stringify({ project: "app" }, null, 2) + "\n", "utf-8");

    const scanned = scanAllSessions(config);

    expect(scanned).toHaveLength(1);
    expect(scanned[0]?.sessionId).toBe("app-1");
  });
});
