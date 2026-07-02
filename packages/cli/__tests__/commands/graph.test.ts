import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import type * as CoreModule from "@aoagents/ao-core";

const { mockConfigRef, mockEnsureGraphBuilt, mockExistsSync } = vi.hoisted(() => ({
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockEnsureGraphBuilt: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof CoreModule;
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
    ensureGraphBuilt: (...args: unknown[]) => mockEnsureGraphBuilt(...args),
    getGraphOutDir: (projectId: string) => `/tmp/ao-graph/${projectId}/graphify-out`,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs");
  return { ...actual, existsSync: (...args: unknown[]) => mockExistsSync(...args) };
});

import { registerGraph } from "../../src/commands/graph.js";

describe("graph command", () => {
  let program: Command;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerGraph(program);

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    process.env = { ...originalEnv };
    delete process.env["AO_PROJECT_ID"];

    mockConfigRef.current = {
      configPath: "/tmp/agent-orchestrator.yaml",
      projects: {
        app: { name: "app", path: "/tmp/app" },
      },
    };
    mockEnsureGraphBuilt.mockReset();
    mockExistsSync.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("builds the graph and prints the json artifact path", async () => {
    mockEnsureGraphBuilt.mockResolvedValue(true);

    await program.parseAsync(["node", "ao", "graph", "build"]);

    expect(mockEnsureGraphBuilt).toHaveBeenCalledWith({ projectId: "app", projectRoot: "/tmp/app" });
    expect(consoleLogSpy).toHaveBeenCalledWith("/tmp/ao-graph/app/graphify-out/graph.json");
  });

  it("exits with an error when the build fails", async () => {
    mockEnsureGraphBuilt.mockResolvedValue(false);

    await expect(program.parseAsync(["node", "ao", "graph", "build"])).rejects.toThrow(
      "process.exit(1)",
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Graph build failed"));
  });

  it("prints the html artifact path by default", async () => {
    mockExistsSync.mockReturnValue(true);

    await program.parseAsync(["node", "ao", "graph", "path"]);

    expect(consoleLogSpy).toHaveBeenCalledWith("/tmp/ao-graph/app/graphify-out/graph.html");
  });

  it("prints the report artifact path with --which report", async () => {
    mockExistsSync.mockReturnValue(true);

    await program.parseAsync(["node", "ao", "graph", "path", "--which", "report"]);

    expect(consoleLogSpy).toHaveBeenCalledWith("/tmp/ao-graph/app/graphify-out/GRAPH_REPORT.md");
  });

  it("exits with an error for an invalid --which", async () => {
    await expect(
      program.parseAsync(["node", "ao", "graph", "path", "--which", "bogus"]),
    ).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --which"));
  });

  it("exits with an error when the artifact doesn't exist yet", async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(program.parseAsync(["node", "ao", "graph", "path"])).rejects.toThrow(
      "process.exit(1)",
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("No graph artifact yet"));
  });

  it("uses --project over auto-detect", async () => {
    mockConfigRef.current = {
      projects: {
        app: { name: "app", path: "/tmp/app" },
        other: { name: "other", path: "/tmp/other" },
      },
    };
    mockEnsureGraphBuilt.mockResolvedValue(true);

    await program.parseAsync(["node", "ao", "graph", "build", "--project", "other"]);

    expect(mockEnsureGraphBuilt).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "other", projectRoot: "/tmp/other" }),
    );
  });
});
