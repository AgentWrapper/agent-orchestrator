import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig, RuntimeHandle, Session } from "@aoagents/ao-core";
import which from "which";
import { execFileSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import plugin, { create, detect, manifest } from "./index.js";

vi.mock("which", () => ({
  default: {
    sync: vi.fn(),
  },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

const mockedWhichSync = vi.mocked(which.sync);
const mockedExecFileSync = vi.mocked(execFileSync);

function projectConfig(path: string): ProjectConfig {
  return {
    path,
    sessionPrefix: "app",
  } as ProjectConfig;
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "app",
    status: "working",
    activity: "active",
    activitySignal: { state: "valid", activity: "active", source: "runtime" },
    lifecycle: {} as Session["lifecycle"],
    branch: "main",
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
    metadata: {},
    ...overrides,
  };
}

function processHandle(pid = 1234): RuntimeHandle {
  return { id: "app-1", runtimeName: "process", data: { pid } };
}

function tmuxHandle(): RuntimeHandle {
  return { id: "app-1", runtimeName: "tmux", data: {} };
}

describe("agent-mistral plugin", () => {
  let tmp: string;
  const previousPath = process.env["PATH"];
  const previousGhPath = process.env["GH_PATH"];
  const previousVibeHome = process.env["VIBE_HOME"];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ao-mistral-test-"));
    vi.clearAllMocks();
    process.env["PATH"] = "/usr/bin:/bin";
    process.env["GH_PATH"] = "/opt/homebrew/bin/gh";
    delete process.env["VIBE_HOME"];
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
    if (previousGhPath === undefined) delete process.env["GH_PATH"];
    else process.env["GH_PATH"] = previousGhPath;
    if (previousVibeHome === undefined) delete process.env["VIBE_HOME"];
    else process.env["VIBE_HOME"] = previousVibeHome;
    vi.restoreAllMocks();
  });

  it("exports the manifest and default plugin shape", () => {
    expect(manifest).toMatchObject({
      name: "mistral",
      slot: "agent",
      description: "Agent plugin: Mistral Vibe CLI",
      displayName: "Mistral Vibe",
    });
    expect(plugin.manifest).toBe(manifest);
    expect(plugin.create).toBe(create);
    expect(plugin.detect).toBe(detect);
  });

  it("creates a Forge-style agent descriptor", () => {
    const agent = create();
    expect(agent.name).toBe("mistral");
    expect(agent.processName).toBe("vibe");
    expect(agent.promptDelivery).toBe("post-launch");
  });

  it("detects the vibe executable with which.sync", () => {
    mockedWhichSync.mockReturnValue("/usr/local/bin/vibe");
    expect(detect()).toBe(true);
    expect(mockedWhichSync).toHaveBeenCalledWith("vibe");
  });

  it("returns false when vibe detection throws", () => {
    mockedWhichSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(detect()).toBe(false);
  });

  it("builds a fresh interactive launch command", () => {
    const agent = create();
    const command = agent.getLaunchCommand({
      sessionId: "app-1",
      projectConfig: projectConfig("/repo/root"),
      workspacePath: "/tmp/work tree",
      prompt: "do not inline me",
    });
    expect(command).toBe("vibe --workdir '/tmp/work tree' --trust");
    expect(command).not.toContain("do not inline me");
    expect(command).not.toContain("--prompt");
  });

  it("maps AO permission modes to documented Vibe agents", () => {
    const agent = create();
    expect(
      agent.getLaunchCommand({
        sessionId: "app-1",
        projectConfig: projectConfig("/repo"),
        permissions: "permissionless",
      }),
    ).toContain("--agent 'auto-approve'");
    expect(
      agent.getLaunchCommand({
        sessionId: "app-1",
        projectConfig: projectConfig("/repo"),
        permissions: "auto-edit",
      }),
    ).toContain("--agent 'accept-edits'");
  });

  it("returns AO and Vibe automation environment", () => {
    const agent = create();
    const env = agent.getEnvironment({
      sessionId: "app-1",
      projectConfig: projectConfig("/repo"),
      model: "devstral-small-2507",
    });
    expect(env.AO_SESSION_ID).toBe("app-1");
    expect(env.AO_SESSION_NAME).toBe("app-1");
    expect(env.PATH).toContain("/usr/bin");
    expect(env.GH_PATH).toBe("/opt/homebrew/bin/gh");
    expect(env.VIBE_ACTIVE_MODEL).toBe("devstral-small-2507");
    expect(env.VIBE_ENABLE_AUTO_UPDATE).toBe("false");
    expect(env.VIBE_ENABLE_UPDATE_CHECKS).toBe("false");
    expect(env.VIBE_ENABLE_NOTIFICATIONS).toBe("false");
  });

  it("checks process-handle liveness with signal 0", async () => {
    const agent = create();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    await expect(agent.isProcessRunning(processHandle(4321))).resolves.toBe(true);
    expect(killSpy).toHaveBeenCalledWith(4321, 0);
  });

  it("treats EPERM from signal 0 as process-running", async () => {
    const agent = create();
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("denied") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    await expect(agent.isProcessRunning(processHandle(4321))).resolves.toBe(true);
  });

  it("returns false for dead process handles", async () => {
    const agent = create();
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("missing") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    await expect(agent.isProcessRunning(processHandle(4321))).resolves.toBe(false);
  });

  it("checks tmux pane TTYs for the vibe process", async () => {
    const agent = create();
    mockedExecFileSync
      .mockReturnValueOnce("/dev/ttys001\n")
      .mockReturnValueOnce("/opt/homebrew/bin/vibe --workdir /repo\n");
    await expect(agent.isProcessRunning(tmuxHandle())).resolves.toBe(true);
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(
      1,
      "tmux",
      ["list-panes", "-t", "app-1", "-F", "#{pane_tty}"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(
      2,
      "ps",
      ["-o", "command=", "-t", "ttys001"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("returns false when tmux has no vibe process", async () => {
    const agent = create();
    mockedExecFileSync.mockReturnValueOnce("/dev/ttys001\n").mockReturnValueOnce("zsh\n");
    await expect(agent.isProcessRunning(tmuxHandle())).resolves.toBe(false);
  });

  it("records idle, active, waiting-input, and blocked terminal activity", async () => {
    const agent = create();
    const s = session({ workspacePath: tmp });

    await agent.recordActivity?.(s, "");
    await agent.recordActivity?.(s, "Thinking about the plan");
    await agent.recordActivity?.(s, "Do you trust this working directory? (y/n)");
    await agent.recordActivity?.(s, "Traceback (most recent call last): boom");

    const log = readFileSync(join(tmp, ".ao", "activity.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { state: string; trigger?: string });
    expect(log.map((entry) => entry.state)).toEqual(["idle", "active", "waiting_input", "blocked"]);
    expect(log[2].trigger).toContain("Do you trust");
    expect(log[3].trigger).toContain("Traceback");
  });

  it("does not record activity without a workspace path", async () => {
    const agent = create();
    await agent.recordActivity?.(session({ workspacePath: null }), "Thinking");
    expect(() => readFileSync(join(tmp, ".ao", "activity.jsonl"), "utf-8")).toThrow();
  });

  it("reports exited activity without a runtime handle", async () => {
    const agent = create();
    const result = await agent.getActivityState(
      session({ workspacePath: tmp, runtimeHandle: null }),
    );
    expect(result?.state).toBe("exited");
  });

  it("reports exited activity when the runtime process is gone", async () => {
    const agent = create();
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("missing") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    const result = await agent.getActivityState(
      session({ workspacePath: tmp, runtimeHandle: processHandle(2222) }),
    );
    expect(result?.state).toBe("exited");
  });

  it("prefers actionable activity-log state", async () => {
    const agent = create();
    vi.spyOn(process, "kill").mockImplementation(() => true);
    await agent.recordActivity?.(
      session({ workspacePath: tmp }),
      "Enter your API key to continue?",
    );
    const result = await agent.getActivityState(
      session({ workspacePath: tmp, runtimeHandle: processHandle(2222) }),
    );
    expect(result?.state).toBe("waiting_input");
  });

  it("falls back to stale idle from the activity log", async () => {
    const agent = create();
    vi.spyOn(process, "kill").mockImplementation(() => true);
    mkdirSync(join(tmp, ".ao"), { recursive: true });
    writeFileSync(
      join(tmp, ".ao", "activity.jsonl"),
      JSON.stringify({
        ts: "2026-01-01T00:00:00.000Z",
        state: "active",
        source: "terminal",
      }) + "\n",
    );
    const result = await agent.getActivityState(
      session({ workspacePath: tmp, runtimeHandle: processHandle(2222) }),
      1,
    );
    expect(result?.state).toBe("idle");
  });

  it("returns null when activity is unavailable", async () => {
    const agent = create();
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const result = await agent.getActivityState(
      session({ workspacePath: tmp, runtimeHandle: processHandle(2222) }),
    );
    expect(result).toBeNull();
  });

  it("extracts session info from Vibe session metadata", async () => {
    const agent = create();
    process.env["VIBE_HOME"] = join(tmp, "vibe-home");
    const logDir = join(process.env["VIBE_HOME"], "logs", "session", "session_20260513_deadbeef");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, "meta.json"),
      JSON.stringify({
        session_id: "deadbeef-0000-0000-0000-123456789abc",
        title: "Refactor parser",
        environment: { working_directory: tmp },
      }),
    );

    const info = await agent.getSessionInfo(session({ workspacePath: tmp }));
    expect(info).toEqual({
      summary: "Refactor parser",
      agentSessionId: "deadbeef-0000-0000-0000-123456789abc",
      metadata: { mistralSessionId: "deadbeef-0000-0000-0000-123456789abc" },
    });
  });

  it("returns null when Vibe metadata is unavailable", async () => {
    const agent = create();
    process.env["VIBE_HOME"] = join(tmp, "missing-vibe-home");
    await expect(agent.getSessionInfo(session({ workspacePath: tmp }))).resolves.toBeNull();
  });

  it("builds a restore command when a Mistral session id was persisted", async () => {
    const agent = create();
    const command = await agent.getRestoreCommand?.(
      session({ workspacePath: "/tmp/work tree", metadata: { mistralSessionId: "abc123" } }),
      projectConfig("/repo/root"),
    );
    expect(command).toBe("vibe --workdir '/tmp/work tree' --trust --resume 'abc123'");
  });

  it("does not fake restore when no Mistral session id is known", async () => {
    const agent = create();
    await expect(
      agent.getRestoreCommand?.(
        session({ workspacePath: "/tmp/work tree" }),
        projectConfig("/repo/root"),
      ),
    ).resolves.toBeNull();
  });
});
