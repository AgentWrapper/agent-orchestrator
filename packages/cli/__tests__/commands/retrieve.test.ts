import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import type * as CoreModule from "@aoagents/ao-core";

const { mockConfigRef, mockAssembleContextBundle } = vi.hoisted(() => ({
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockAssembleContextBundle: vi.fn(),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof CoreModule;
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
    assembleContextBundle: (...args: unknown[]) => mockAssembleContextBundle(...args),
  };
});

import { registerRetrieve } from "../../src/commands/retrieve.js";

describe("retrieve command", () => {
  let program: Command;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerRetrieve(program);

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
        app: {
          name: "app",
          path: "/tmp/app",
        },
      },
    };
    mockAssembleContextBundle.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("prints the bundle markdown by default and forwards projectId/projectRoot", async () => {
    mockAssembleContextBundle.mockResolvedValue({
      markdown: "## Контекст задачи (maestro-retrieval)\n\n- NODE foo",
      json: { itemsPacked: 1, tokensPacked: 10, dedupSaved: 0 },
    });

    await program.parseAsync(["node", "ao", "retrieve", "fix the chat bug"]);

    expect(mockAssembleContextBundle).toHaveBeenCalledWith({
      projectId: "app",
      projectRoot: "/tmp/app",
      taskText: "fix the chat bug",
    });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("NODE foo"));
  });

  it("prints JSON accounting with --json", async () => {
    mockAssembleContextBundle.mockResolvedValue({
      markdown: "bundle text",
      json: { itemsPacked: 2, tokensPacked: 20, dedupSaved: 1 },
    });

    await program.parseAsync(["node", "ao", "retrieve", "query", "--json"]);

    const printed = consoleLogSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(printed);
    expect(parsed.markdown).toBe("bundle text");
    expect(parsed.json.itemsPacked).toBe(2);
  });

  it("degrades gracefully when the bundle is null (fail-open)", async () => {
    mockAssembleContextBundle.mockResolvedValue(null);

    await program.parseAsync(["node", "ao", "retrieve", "no matches"]);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("No retrieval context available"),
    );
  });

  it("uses --project over auto-detect", async () => {
    mockConfigRef.current = {
      projects: {
        app: { name: "app", path: "/tmp/app" },
        other: { name: "other", path: "/tmp/other" },
      },
    };
    mockAssembleContextBundle.mockResolvedValue(null);

    await program.parseAsync(["node", "ao", "retrieve", "query", "--project", "other"]);

    expect(mockAssembleContextBundle).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "other", projectRoot: "/tmp/other" }),
    );
  });

  it("exits with an error when multiple projects exist and none resolves", async () => {
    mockConfigRef.current = {
      projects: {
        app: { name: "app", path: "/tmp/app" },
        other: { name: "other", path: "/tmp/other" },
      },
    };

    await expect(
      program.parseAsync(["node", "ao", "retrieve", "query"]),
    ).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Multiple projects configured"),
    );
  });
});
