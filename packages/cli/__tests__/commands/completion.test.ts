import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import type * as CoreModule from "@aoagents/ao-core";
import type { Session } from "@aoagents/ao-core";

const { mockConfigRef, mockSessionManager } = vi.hoisted(() => ({
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockSessionManager: {
    list: vi.fn(),
  },
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof CoreModule;
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
    loadGlobalConfig: () => null,
    getGlobalConfigPath: () => "/nonexistent/config.yaml",
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async () => mockSessionManager,
}));

import { registerCompletion } from "../../src/commands/completion.js";
import {
  formatCompletionSuggestions,
  generateZshCompletion,
  getCompletionSuggestions,
} from "../../src/lib/completion.js";

function makeSession(
  id: string,
  projectId: string,
  status: Session["status"] = "working",
): Session {
  const isTerminal = status === "done" || status === "terminated" || status === "merged";
  return {
    id,
    projectId,
    status,
    activity: null,
    activitySignal: {
      state: "null",
      activity: null,
      source: "none",
    },
    lifecycle: {
      version: 2,
      session: {
        kind: "worker",
        state: isTerminal ? "done" : "working",
        reason: isTerminal ? "research_complete" : "task_in_progress",
        startedAt: new Date().toISOString(),
        completedAt: isTerminal ? new Date().toISOString() : null,
        terminatedAt: null,
        lastTransitionAt: new Date().toISOString(),
      },
      pr: {
        state: "none",
        reason: "not_created",
        number: null,
        url: null,
        lastObservedAt: null,
      },
      runtime: {
        state: "alive",
        reason: "process_running",
        lastObservedAt: new Date().toISOString(),
        handle: null,
        tmuxName: null,
      },
    },
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
  };
}

describe("completion commands", () => {
  let program: Command;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerCompletion(program);

    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    mockConfigRef.current = {
      projects: {
        app: {
          name: "App",
          path: "/tmp/app",
          repo: "org/app",
          sessionPrefix: "app",
        },
        api: {
          name: "API",
          path: "/tmp/api",
          repo: "org/api",
          sessionPrefix: "api",
        },
      },
    };

    mockSessionManager.list.mockReset();
    mockSessionManager.list.mockResolvedValue([]);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it("prints the zsh completion script", async () => {
    await program.parseAsync(["node", "test", "completion", "zsh"]);

    const output = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("#compdef ao");
    expect(output).toContain("command ao __complete");
    expect(output).toContain("_ao_complete_projects");
    expect(output).toContain("_ao_completion");
    expect(output).toContain("_ao_completion_zsh");
  });

  it("emits a zsh completion file that runs on the first autoloaded invocation", () => {
    const output = generateZshCompletion(program);
    expect(output).toContain('_ao "$@"');
  });

  it("prints configured project suggestions for the hidden helper", async () => {
    await program.parseAsync(["node", "test", "__complete", "projects"]);

    const output = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("api\tAPI - org/api - /tmp/api");
    expect(output).toContain("app\tApp - org/app - /tmp/app");
  });

  it("filters orchestrator and terminated sessions by default", async () => {
    mockSessionManager.list.mockResolvedValue([
      makeSession("app-1", "app", "working"),
      makeSession("app-2", "app", "done"),
      makeSession("app-orchestrator", "app", "working"),
    ]);

    await program.parseAsync(["node", "test", "__complete", "sessions"]);

    const output = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("app-1\tapp [working]");
    expect(output).not.toContain("app-2");
    expect(output).not.toContain("app-orchestrator");
  });

  it("includes terminated and orchestrator sessions when requested", async () => {
    mockSessionManager.list.mockResolvedValue([
      makeSession("app-1", "app", "working"),
      makeSession("app-2", "app", "done"),
      makeSession("app-orchestrator", "app", "working"),
    ]);

    await program.parseAsync([
      "node",
      "test",
      "__complete",
      "sessions",
      "--include-terminated",
      "--include-orchestrators",
    ]);

    const output = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("app-1\tapp [working]");
    expect(output).toContain("app-2\tapp [done]");
    expect(output).toContain("app-orchestrator\tapp [working]");
  });

  it("returns no suggestions for an unknown completion kind", async () => {
    await program.parseAsync(["node", "test", "__complete", "unsupported"]);

    const output = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toBe("");
  });

  it("returns empty project suggestions when config loading fails", async () => {
    mockConfigRef.current = null as any;

    await program.parseAsync(["node", "test", "__complete", "projects"]);

    const output = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toBe("");
  });

  it("returns empty session suggestions when config loading fails", async () => {
    mockConfigRef.current = null as any;

    await program.parseAsync(["node", "test", "__complete", "sessions"]);

    const output = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toBe("");
  });

  it("sanitizes completion output values and descriptions", () => {
    const formatted = formatCompletionSuggestions([
      { value: "a\tvalue", description: "has:\tweird\nchars" },
      { value: "plain", description: undefined },
    ]);

    expect(formatted).toContain("a value\thas: weird chars");
    expect(formatted).toContain("plain");
  });

  it("returns no suggestions for unknown helper kind", async () => {
    const items = await getCompletionSuggestions("mystery");
    expect(items).toEqual([]);
  });
});
