import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import type * as CoreModule from "@aoagents/ao-core";

const { mockConfigRef, mockSessionManager, mockApplyAgentReport, mockGetProjectSessionsDir } = vi.hoisted(
  () => ({
    mockConfigRef: { current: null as Record<string, unknown> | null },
    mockSessionManager: {
      get: vi.fn(),
    },
    mockApplyAgentReport: vi.fn(),
    mockGetProjectSessionsDir: vi.fn(),
  }),
);

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof CoreModule;
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
    getProjectSessionsDir: (...args: unknown[]) => mockGetProjectSessionsDir(...args),
    applyAgentReport: (...args: unknown[]) => mockApplyAgentReport(...args),
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async () => mockSessionManager,
}));

import { registerAcknowledge, registerReport } from "../../src/commands/report.js";

describe("report commands", () => {
  let program: Command;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerAcknowledge(program);
    registerReport(program);

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    process.env = { ...originalEnv };
    delete process.env["AO_SESSION_ID"];
    process.env["USER"] = "codex";

    mockConfigRef.current = {
      configPath: "/tmp/agent-orchestrator.yaml",
      projects: {
        app: {
          name: "app",
          path: "/tmp/app",
        },
      },
    };
    mockSessionManager.get.mockReset();
    mockApplyAgentReport.mockReset();
    mockGetProjectSessionsDir.mockReset();
    mockGetProjectSessionsDir.mockReturnValue("/tmp/sessions");
    mockSessionManager.get.mockResolvedValue({
      id: "app-1",
      projectId: "app",
    });
    mockApplyAgentReport.mockReturnValue({
      previousState: "working",
      nextState: "started",
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("uses AO_SESSION_ID for acknowledge when no explicit session is provided", async () => {
    process.env["AO_SESSION_ID"] = "app-1";

    await program.parseAsync(["node", "test", "acknowledge", "--note", "picked up"]);

    expect(mockSessionManager.get).toHaveBeenCalledWith("app-1");
    expect(mockApplyAgentReport).toHaveBeenCalledWith(
      "/tmp/sessions",
      "app-1",
      expect.objectContaining({
        state: "started",
        note: "picked up",
        source: "acknowledge",
        actor: "codex",
      }),
    );
  });

  it("prefers explicit --session over AO_SESSION_ID", async () => {
    process.env["AO_SESSION_ID"] = "wrong-session";

    await program.parseAsync(["node", "test", "report", "working", "--session", "app-2"]);

    expect(mockSessionManager.get).toHaveBeenCalledWith("app-2");
  });

  it("rejects unknown states before touching the session manager", async () => {
    await expect(program.parseAsync(["node", "test", "report", "bogus-state"])).rejects.toThrow(
      "process.exit(1)",
    );

    expect(mockSessionManager.get).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown state"));
  });

  it("rejects invalid PR numbers", async () => {
    await expect(
      program.parseAsync(["node", "test", "report", "pr-created", "--pr-number", "abc"]),
    ).rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid PR number"));
  });

  it("rejects PR metadata flags for non-PR workflow states", async () => {
    await expect(
      program.parseAsync(["node", "test", "report", "working", "--pr-url", "https://example.com"]),
    ).rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("PR metadata flags are only valid"),
    );
  });

  it("surfaces session-not-found errors", async () => {
    mockSessionManager.get.mockResolvedValue(null);

    await expect(program.parseAsync(["node", "test", "report", "working", "--session", "app-1"]))
      .rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Session not found"));
  });

  it("surfaces project-not-found errors", async () => {
    mockConfigRef.current = {
      configPath: "/tmp/agent-orchestrator.yaml",
      projects: {},
    };

    await expect(program.parseAsync(["node", "test", "report", "working", "--session", "app-1"]))
      .rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Project not found for session"),
    );
  });

  it("surfaces rejected reports from applyAgentReport", async () => {
    mockApplyAgentReport.mockImplementation(() => {
      throw new Error("PR number 7 does not match PR URL");
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "report",
        "pr-created",
        "--session",
        "app-1",
        "--pr-number",
        "7",
        "--pr-url",
        "https://github.com/acme/app/pull/9",
      ]),
    ).rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Report rejected: PR number 7 does not match PR URL"),
    );
  });
});
