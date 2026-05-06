import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { validateSession } from "../recovery/validator.js";
import type { ScannedSession } from "../recovery/scanner.js";
import type { Agent, OrchestratorConfig, PluginRegistry, Runtime, Workspace } from "../types.js";
import { getProjectSessionsDir } from "../paths.js";

describe("recovery validator", () => {
  let rootDir = "";

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("uses role-specific orchestrator agent fallback when metadata is missing agent", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const mockRuntime: Runtime = {
      name: "tmux",
      create: vi.fn(),
      destroy: vi.fn(),
      sendMessage: vi.fn(),
      getOutput: vi.fn(),
      isAlive: vi.fn().mockResolvedValue(true),
    };
    const mockWorkspace: Workspace = {
      name: "worktree",
      create: vi.fn(),
      destroy: vi.fn(),
      list: vi.fn(),
      exists: vi.fn().mockResolvedValue(true),
    };
    const mockWorkerAgent: Agent = {
      name: "mock-agent",
      processName: "mock-agent",
      getLaunchCommand: vi.fn(),
      getEnvironment: vi.fn(),
      detectActivity: vi.fn(),
      getActivityState: vi.fn(),
      isProcessRunning: vi.fn().mockResolvedValue(false),
      getSessionInfo: vi.fn(),
    };
    const mockOrchestratorAgent: Agent = {
      ...mockWorkerAgent,
      name: "codex",
      processName: "codex",
      isProcessRunning: vi.fn().mockResolvedValue(true),
    };
    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "agent") {
          if (name === "codex") return mockOrchestratorAgent;
          if (name === "mock-agent") return mockWorkerAgent;
        }
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };
    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      power: { preventIdleSleep: false },
      defaults: {
        runtime: "tmux",
        agent: "mock-agent",
        workspace: "worktree",
        notifiers: ["desktop"],
      },
      projects: {
        app: {
          name: "app",
          repo: "org/repo",
          path: projectPath,
          defaultBranch: "main",
          sessionPrefix: "app",
          agent: "mock-agent",
          orchestrator: {
            agent: "codex",
          },
        },
      },
      notifiers: {},
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: [],
        info: [],
      },
      reactions: {},
    };
    const scanned: ScannedSession = {
      sessionId: "app-orchestrator",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getProjectSessionsDir("app"),
      rawMetadata: {
        worktree: projectPath,
        status: "working",
        role: "orchestrator",
        runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "tmux", data: {} }),
      },
    };

    const assessment = await validateSession(scanned, config, registry);

    expect(assessment.agentProcessRunning).toBe(true);
    expect(mockOrchestratorAgent.isProcessRunning).toHaveBeenCalled();
    expect(mockWorkerAgent.isProcessRunning).not.toHaveBeenCalled();
  });

  it("sets runtimeAlive to false when runtime.isAlive throws an error", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const mockRuntime: Runtime = {
      name: "tmux",
      create: vi.fn(),
      destroy: vi.fn(),
      sendMessage: vi.fn(),
      getOutput: vi.fn(),
      isAlive: vi.fn().mockRejectedValue(new Error("Runtime check failed")),
    };
    const mockWorkspace: Workspace = {
      name: "worktree",
      create: vi.fn(),
      destroy: vi.fn(),
      list: vi.fn(),
      exists: vi.fn().mockResolvedValue(true),
    };
    const mockAgent: Agent = {
      name: "mock-agent",
      processName: "mock-agent",
      getLaunchCommand: vi.fn(),
      getEnvironment: vi.fn(),
      detectActivity: vi.fn(),
      getActivityState: vi.fn(),
      isProcessRunning: vi.fn().mockResolvedValue(false),
      getSessionInfo: vi.fn(),
    };
    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "agent") return mockAgent;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };
    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      power: { preventIdleSleep: false },
      defaults: {
        runtime: "tmux",
        agent: "mock-agent",
        workspace: "worktree",
        notifiers: ["desktop"],
      },
      projects: {
        app: {
          name: "app",
          repo: "org/repo",
          path: projectPath,
          defaultBranch: "main",
          sessionPrefix: "app",
        },
      },
      notifiers: {},
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: [],
        info: [],
      },
      reactions: {},
    };
    const scanned: ScannedSession = {
      sessionId: "app-1",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getProjectSessionsDir("app"),
      rawMetadata: {
        worktree: join(rootDir, "missing-worktree"),
        status: "working",
        runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "tmux", data: {} }),
      },
    };

    const assessment = await validateSession(scanned, config, registry);

    expect(mockRuntime.isAlive).toHaveBeenCalled();
    expect(assessment.runtimeAlive).toBe(false);
    expect(assessment.runtimeProbeSucceeded).toBe(false);
    expect(assessment.classification).toBe("partial");
    expect(assessment.action).toBe("escalate");
    expect(assessment.reason).toContain("Probe uncertainty");
  });

  it("escalates when runtime and process signals disagree", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const mockRuntime: Runtime = {
      name: "tmux",
      create: vi.fn(),
      destroy: vi.fn(),
      sendMessage: vi.fn(),
      getOutput: vi.fn(),
      isAlive: vi.fn().mockResolvedValue(false),
    };
    const mockWorkspace: Workspace = {
      name: "worktree",
      create: vi.fn(),
      destroy: vi.fn(),
      list: vi.fn(),
      exists: vi.fn().mockResolvedValue(true),
    };
    const mockAgent: Agent = {
      name: "mock-agent",
      processName: "mock-agent",
      getLaunchCommand: vi.fn(),
      getEnvironment: vi.fn(),
      detectActivity: vi.fn(),
      getActivityState: vi.fn(),
      isProcessRunning: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn(),
    };
    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "agent") return mockAgent;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };
    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      power: { preventIdleSleep: false },
      defaults: {
        runtime: "tmux",
        agent: "mock-agent",
        workspace: "worktree",
        notifiers: ["desktop"],
      },
      projects: {
        app: {
          name: "app",
          repo: "org/repo",
          path: projectPath,
          defaultBranch: "main",
          sessionPrefix: "app",
        },
      },
      notifiers: {},
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: [],
        info: [],
      },
      reactions: {},
    };
    const scanned: ScannedSession = {
      sessionId: "app-1",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getProjectSessionsDir("app"),
      rawMetadata: {
        worktree: join(rootDir, "missing-worktree"),
        status: "working",
        runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "tmux", data: {} }),
      },
    };

    const assessment = await validateSession(scanned, config, registry);

    expect(assessment.signalDisagreement).toBe(true);
    expect(assessment.recoveryRule).toBe("human");
    expect(assessment.action).toBe("escalate");
    expect(assessment.reason).toContain("Signal disagreement");
  });

  it("uses agent activity as liveness fallback when process probing says not running", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const mockRuntime: Runtime = {
      name: "tmux",
      create: vi.fn(),
      destroy: vi.fn(),
      sendMessage: vi.fn(),
      getOutput: vi.fn(),
      isAlive: vi.fn().mockResolvedValue(true),
    };
    const mockWorkspace: Workspace = {
      name: "worktree",
      create: vi.fn(),
      destroy: vi.fn(),
      list: vi.fn(),
      exists: vi.fn().mockResolvedValue(true),
    };
    const mockAgent: Agent = {
      name: "mock-agent",
      processName: "mock-agent",
      getLaunchCommand: vi.fn(),
      getEnvironment: vi.fn(),
      detectActivity: vi.fn(),
      getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
      isProcessRunning: vi.fn().mockResolvedValue(false),
      getSessionInfo: vi.fn(),
    };
    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "agent") return mockAgent;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };
    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      power: { preventIdleSleep: false },
      defaults: {
        runtime: "tmux",
        agent: "mock-agent",
        workspace: "worktree",
        notifiers: ["desktop"],
      },
      projects: {
        app: {
          name: "app",
          repo: "org/repo",
          path: projectPath,
          defaultBranch: "main",
          sessionPrefix: "app",
        },
      },
      notifiers: {},
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: [],
        info: [],
      },
      reactions: {},
    };
    const scanned: ScannedSession = {
      sessionId: "app-1",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getProjectSessionsDir("app"),
      rawMetadata: {
        worktree: projectPath,
        status: "working",
        runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "tmux", data: {} }),
      },
    };

    const assessment = await validateSession(scanned, config, registry);

    expect(mockAgent.getActivityState).toHaveBeenCalled();
    expect(assessment.agentActivity).toBe("active");
    expect(assessment.agentProcessRunning).toBe(true);
    expect(assessment.classification).toBe("live");
  });

  it("keeps terminal metadata unrecoverable even when probes are uncertain", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const mockWorkspace: Workspace = {
      name: "worktree",
      create: vi.fn(),
      destroy: vi.fn(),
      list: vi.fn(),
      exists: vi.fn().mockResolvedValue(false),
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
    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      power: { preventIdleSleep: false },
      defaults: {
        runtime: "tmux",
        agent: "mock-agent",
        workspace: "worktree",
        notifiers: ["desktop"],
      },
      projects: {
        app: {
          name: "app",
          repo: "org/repo",
          path: projectPath,
          defaultBranch: "main",
          sessionPrefix: "app",
        },
      },
      notifiers: {},
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: [],
        info: [],
      },
      reactions: {},
    };
    const scanned: ScannedSession = {
      sessionId: "app-1",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getProjectSessionsDir("app"),
      rawMetadata: {
        worktree: projectPath,
        status: "merged",
      },
    };

    const assessment = await validateSession(scanned, config, registry);

    expect(assessment.classification).toBe("unrecoverable");
    expect(assessment.recoveryRule).toBe("skip");
    expect(assessment.action).toBe("skip");
  });

  it("recovers healthy sessions even if stale metadata still says detecting", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const mockRuntime: Runtime = {
      name: "tmux",
      create: vi.fn(),
      destroy: vi.fn(),
      sendMessage: vi.fn(),
      getOutput: vi.fn(),
      isAlive: vi.fn().mockResolvedValue(true),
    };
    const mockWorkspace: Workspace = {
      name: "worktree",
      create: vi.fn(),
      destroy: vi.fn(),
      list: vi.fn(),
      exists: vi.fn().mockResolvedValue(true),
    };
    const mockAgent: Agent = {
      name: "mock-agent",
      processName: "mock-agent",
      getLaunchCommand: vi.fn(),
      getEnvironment: vi.fn(),
      detectActivity: vi.fn(),
      getActivityState: vi.fn(),
      isProcessRunning: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn(),
    };
    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "agent") return mockAgent;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };
    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      power: { preventIdleSleep: false },
      defaults: {
        runtime: "tmux",
        agent: "mock-agent",
        workspace: "worktree",
        notifiers: ["desktop"],
      },
      projects: {
        app: {
          name: "app",
          repo: "org/repo",
          path: projectPath,
          defaultBranch: "main",
          sessionPrefix: "app",
        },
      },
      notifiers: {},
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: [],
        info: [],
      },
      reactions: {},
    };
    const scanned: ScannedSession = {
      sessionId: "app-1",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getProjectSessionsDir("app"),
      rawMetadata: {
        worktree: projectPath,
        status: "detecting",
        runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "tmux", data: {} }),
      },
    };

    const assessment = await validateSession(scanned, config, registry);

    expect(assessment.classification).toBe("live");
    expect(assessment.recoveryRule).toBe("auto");
    expect(assessment.action).toBe("recover");
  });

  it("treats missing runtime handle plus missing workspace as dead metadata", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const mockWorkspace: Workspace = {
      name: "worktree",
      create: vi.fn(),
      destroy: vi.fn(),
      list: vi.fn(),
      exists: vi.fn().mockResolvedValue(false),
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
    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      power: { preventIdleSleep: false },
      defaults: {
        runtime: "tmux",
        agent: "mock-agent",
        workspace: "worktree",
        notifiers: ["desktop"],
      },
      projects: {
        app: {
          name: "app",
          repo: "org/repo",
          path: projectPath,
          defaultBranch: "main",
          sessionPrefix: "app",
        },
      },
      notifiers: {},
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: [],
        info: [],
      },
      reactions: {},
    };
    const scanned: ScannedSession = {
      sessionId: "app-1",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getProjectSessionsDir("app"),
      rawMetadata: {
        worktree: join(rootDir, "missing-worktree"),
        status: "working",
      },
    };

    const assessment = await validateSession(scanned, config, registry);

    expect(assessment.classification).toBe("dead");
    expect(assessment.recoveryRule).toBe("auto");
    expect(assessment.action).toBe("cleanup");
  });

  it("respects escalatePartial=false for non-disagreement partial sessions", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const mockRuntime: Runtime = {
      name: "tmux",
      create: vi.fn(),
      destroy: vi.fn(),
      sendMessage: vi.fn(),
      getOutput: vi.fn(),
      isAlive: vi.fn().mockResolvedValue(true),
    };
    const mockWorkspace: Workspace = {
      name: "worktree",
      create: vi.fn(),
      destroy: vi.fn(),
      list: vi.fn(),
      exists: vi.fn().mockResolvedValue(false),
    };
    const mockAgent: Agent = {
      name: "mock-agent",
      processName: "mock-agent",
      getLaunchCommand: vi.fn(),
      getEnvironment: vi.fn(),
      detectActivity: vi.fn(),
      getActivityState: vi.fn(),
      isProcessRunning: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn(),
    };
    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "agent") return mockAgent;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };
    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      power: { preventIdleSleep: false },
      defaults: {
        runtime: "tmux",
        agent: "mock-agent",
        workspace: "worktree",
        notifiers: ["desktop"],
      },
      projects: {
        app: {
          name: "app",
          repo: "org/repo",
          path: projectPath,
          defaultBranch: "main",
          sessionPrefix: "app",
        },
      },
      notifiers: {},
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: [],
        info: [],
      },
      reactions: {},
    };
    const scanned: ScannedSession = {
      sessionId: "app-1",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getProjectSessionsDir("app"),
      rawMetadata: {
        worktree: join(rootDir, "missing-worktree"),
        status: "working",
        runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "tmux", data: {} }),
      },
    };

    const assessment = await validateSession(scanned, config, registry, {
      escalatePartial: false,
    });

    expect(assessment.classification).toBe("partial");
    expect(assessment.signalDisagreement).toBe(false);
    expect(assessment.recoveryRule).toBe("auto");
    expect(assessment.action).toBe("cleanup");
  });
});
