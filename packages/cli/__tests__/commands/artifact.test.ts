import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as CoreModule from "@aoagents/ao-core";

const { mockConfigRef, mockSessionManager, mockStagingDirRef } = vi.hoisted(() => ({
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockSessionManager: {
    get: vi.fn(),
  },
  mockStagingDirRef: { current: "" as string },
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof CoreModule;
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
    getSessionArtifactsStagingDir: (_projectId: string, _sessionId: string) =>
      mockStagingDirRef.current,
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async () => mockSessionManager,
}));

import { registerArtifact } from "../../src/commands/artifact.js";

describe("ao artifact publish", () => {
  let program: Command;
  let tmpRoot: string;
  let stagingDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    program = new Command();
    program.exitOverride();
    registerArtifact(program);

    tmpRoot = mkdtempSync(join(tmpdir(), "ao-artifact-test-"));
    stagingDir = join(tmpRoot, "staging");
    await mkdir(stagingDir, { recursive: true });
    mockStagingDirRef.current = stagingDir;

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code ?? 0})`);
    });

    process.env = { ...originalEnv };
    delete process.env["AO_SESSION_ID"];

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
    mockSessionManager.get.mockResolvedValue({
      id: "app-1",
      projectId: "app",
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Simulate the watcher consuming the staging file successfully after the
   * CLI writes it. We do this on a timer so the CLI's polling loop observes
   * the staging file briefly, then sees it disappear.
   *
   * Delay tuned for CI: needs to be long enough that the CLI's async
   * writeFile completes AND the readback timer (~80ms) can capture the
   * staging content before this "watcher" deletes it.
   */
  function scheduleIngestSuccess(artifactId: string, delayMs = 300): NodeJS.Timeout {
    return setTimeout(() => {
      const stagingPath = join(stagingDir, `${artifactId}.json`);
      if (existsSync(stagingPath)) unlinkSync(stagingPath);
    }, delayMs);
  }

  /** Simulate the watcher writing a .error sidecar after validation failure. */
  function scheduleIngestError(
    artifactId: string,
    issues: { path: string[]; message: string }[],
    delayMs = 60,
  ): NodeJS.Timeout {
    return setTimeout(() => {
      const errorPath = join(stagingDir, `${artifactId}.error`);
      writeFileSync(
        errorPath,
        JSON.stringify({ issues, at: new Date().toISOString() }, null, 2),
        "utf-8",
      );
    }, delayMs);
  }

  it("writes a valid markdown artifact to the staging dir", async () => {
    process.env["AO_SESSION_ID"] = "app-1";
    const timer = scheduleIngestSuccess("plan-v1");

    // We need to inspect the staging file BEFORE the watcher consumes it.
    // Use a synchronous read scheduled at t=0 (before our 60ms delete).
    let captured: string | null = null;
    const readTimer = setTimeout(() => {
      const path = join(stagingDir, "plan-v1.json");
      if (existsSync(path)) captured = readFileSync(path, "utf-8");
    }, 80);

    try {
      await expect(
        program.parseAsync([
          "node",
          "test",
          "artifact",
          "publish",
          "--type",
          "markdown",
          "--id",
          "plan-v1",
          "--title",
          "Plan",
          "--content",
          "# hello",
        ]),
      ).rejects.toThrow("process.exit(0)");
    } finally {
      clearTimeout(timer);
      clearTimeout(readTimer);
    }

    expect(captured).not.toBeNull();
    const body = JSON.parse(captured as unknown as string);
    expect(body).toMatchObject({
      id: "plan-v1",
      type: "markdown",
      title: "Plan",
      payload: { markdown: "# hello" },
    });
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('published'),
    );
  });

  it("writes a valid html artifact to the staging dir", async () => {
    process.env["AO_SESSION_ID"] = "app-1";
    const timer = scheduleIngestSuccess("diff-html");
    let captured: string | null = null;
    const readTimer = setTimeout(() => {
      const path = join(stagingDir, "diff-html.json");
      if (existsSync(path)) captured = readFileSync(path, "utf-8");
    }, 80);

    try {
      await expect(
        program.parseAsync([
          "node",
          "test",
          "artifact",
          "publish",
          "--type",
          "html",
          "--id",
          "diff-html",
          "--title",
          "Diff",
          "--content",
          "<p>hi</p>",
        ]),
      ).rejects.toThrow("process.exit(0)");
    } finally {
      clearTimeout(timer);
      clearTimeout(readTimer);
    }

    const body = JSON.parse(captured as unknown as string);
    expect(body.type).toBe("html");
    expect(body.payload).toEqual({ html: "<p>hi</p>" });
  });

  it("polls for .error sidecar and surfaces validation errors", async () => {
    process.env["AO_SESSION_ID"] = "app-1";
    const timer = scheduleIngestError(
      "bad",
      [{ path: ["title"], message: "title is too short" }],
      40,
    );

    try {
      await expect(
        program.parseAsync([
          "node",
          "test",
          "artifact",
          "publish",
          "--type",
          "markdown",
          "--id",
          "bad",
          "--title",
          "X",
          "--content",
          "hi",
        ]),
      ).rejects.toThrow("process.exit(1)");
    } finally {
      clearTimeout(timer);
    }

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("title is too short"),
    );
  });

  it("exits with code 1 on validation failure", async () => {
    process.env["AO_SESSION_ID"] = "app-1";
    const timer = scheduleIngestError(
      "bad",
      [{ path: ["id"], message: 'id prefix "core-" is reserved' }],
      40,
    );

    try {
      await expect(
        program.parseAsync([
          "node",
          "test",
          "artifact",
          "publish",
          "--type",
          "markdown",
          "--id",
          "bad",
          "--title",
          "X",
          "--content",
          "hi",
          "--json",
        ]),
      ).rejects.toThrow("process.exit(1)");
    } finally {
      clearTimeout(timer);
    }

    // JSON mode: error goes to stdout
    expect(consoleLogSpy).toHaveBeenCalled();
    const arg = (consoleLogSpy.mock.calls[0] as string[])[0];
    const parsed = JSON.parse(arg as unknown as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.id).toBe("bad");
    expect(parsed.error.issues[0].message).toContain("reserved");
  });

  it("supports --spec-file for complex payloads", async () => {
    process.env["AO_SESSION_ID"] = "app-1";
    const specPath = join(tmpRoot, "spec.json");
    const spec = {
      id: "plan-from-spec",
      type: "markdown",
      title: "From Spec",
      payload: {
        markdown: "# Plan from spec",
      },
    };
    writeFileSync(specPath, JSON.stringify(spec), "utf-8");

    const timer = scheduleIngestSuccess("plan-from-spec");
    let captured: string | null = null;
    const readTimer = setTimeout(() => {
      const path = join(stagingDir, "plan-from-spec.json");
      if (existsSync(path)) captured = readFileSync(path, "utf-8");
    }, 80);

    try {
      await expect(
        program.parseAsync([
          "node",
          "test",
          "artifact",
          "publish",
          "--spec-file",
          specPath,
        ]),
      ).rejects.toThrow("process.exit(0)");
    } finally {
      clearTimeout(timer);
      clearTimeout(readTimer);
    }

    const body = JSON.parse(captured as unknown as string);
    expect(body).toEqual(spec);
  });

  it("requires --type unless --spec-file is used", async () => {
    process.env["AO_SESSION_ID"] = "app-1";
    await expect(
      program.parseAsync([
        "node",
        "test",
        "artifact",
        "publish",
        "--id",
        "x",
        "--title",
        "X",
      ]),
    ).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("--type"));
  });

  it("uses AO_SESSION_ID when --session is not provided", async () => {
    process.env["AO_SESSION_ID"] = "app-1";
    const timer = scheduleIngestSuccess("hello");

    try {
      await expect(
        program.parseAsync([
          "node",
          "test",
          "artifact",
          "publish",
          "--type",
          "markdown",
          "--id",
          "hello",
          "--title",
          "Hello",
          "--content",
          "world",
        ]),
      ).rejects.toThrow("process.exit(0)");
    } finally {
      clearTimeout(timer);
    }
    expect(mockSessionManager.get).toHaveBeenCalledWith("app-1");
  });

  it("prefers explicit --session over AO_SESSION_ID", async () => {
    process.env["AO_SESSION_ID"] = "wrong-session";
    const timer = scheduleIngestSuccess("hello");

    try {
      await expect(
        program.parseAsync([
          "node",
          "test",
          "artifact",
          "publish",
          "--session",
          "app-2",
          "--type",
          "markdown",
          "--id",
          "hello",
          "--title",
          "Hello",
          "--content",
          "world",
        ]),
      ).rejects.toThrow("process.exit(0)");
    } finally {
      clearTimeout(timer);
    }
    expect(mockSessionManager.get).toHaveBeenCalledWith("app-2");
  });

  it("surfaces session-not-found errors", async () => {
    process.env["AO_SESSION_ID"] = "ghost";
    mockSessionManager.get.mockResolvedValue(null);

    await expect(
      program.parseAsync([
        "node",
        "test",
        "artifact",
        "publish",
        "--type",
        "markdown",
        "--id",
        "x",
        "--title",
        "X",
        "--content",
        "y",
      ]),
    ).rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Session not found"));
  });

  it("times out and exits non-zero if neither sidecar nor delete occurs", async () => {
    process.env["AO_SESSION_ID"] = "app-1";

    await expect(
      program.parseAsync([
        "node",
        "test",
        "artifact",
        "publish",
        "--type",
        "markdown",
        "--id",
        "stuck",
        "--title",
        "X",
        "--content",
        "y",
      ]),
    ).rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("timeout"));
  }, 5000);
});
