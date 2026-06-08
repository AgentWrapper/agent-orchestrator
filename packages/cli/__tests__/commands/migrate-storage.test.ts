/**
 * Tests for migrate-storage activity-event instrumentation (issue #1654).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import * as AoCore from "@aoagents/ao-core";

const { mockMigrateStorage, mockRollbackStorage } = vi.hoisted(() => ({
  mockMigrateStorage: vi.fn(),
  mockRollbackStorage: vi.fn(),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = await importOriginal<typeof AoCore>();
  return {
    ...actual,
    migrateStorage: (...args: unknown[]) => mockMigrateStorage(...args),
    rollbackStorage: (...args: unknown[]) => mockRollbackStorage(...args),
    recordActivityEvent: vi.fn(),
  };
});

import { registerMigrateStorage } from "../../src/commands/migrate-storage.js";

const recordedEvents = (): Array<Record<string, unknown>> =>
  vi.mocked(AoCore.recordActivityEvent).mock.calls.map((c) => c[0] as Record<string, unknown>);

describe("ao migrate-storage — activity events", () => {
  let program: Command;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(AoCore.recordActivityEvent).mockClear();
    mockMigrateStorage.mockReset();
    mockRollbackStorage.mockReset();

    program = new Command();
    program.exitOverride();
    registerMigrateStorage(program);

    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consoleErrSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it("emits cli.migration_invoked before migration work starts", async () => {
    mockMigrateStorage.mockImplementation(async () => {
      expect(recordedEvents()).toContainEqual(
        expect.objectContaining({
          kind: "cli.migration_invoked",
          source: "cli",
          level: "info",
          data: expect.objectContaining({
            rollback: false,
            dryRun: true,
            force: true,
          }),
        }),
      );
      return { projects: 1 };
    });

    await program.parseAsync(["node", "ao", "migrate-storage", "--dry-run", "--force"]);

    expect(mockMigrateStorage).toHaveBeenCalledOnce();
  });

  it("emits cli.migration_failed when migrateStorage throws", async () => {
    mockMigrateStorage.mockRejectedValue(new Error("disk full"));

    await program.parseAsync(["node", "ao", "migrate-storage"]);

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.migration_failed",
        source: "cli",
        level: "error",
        data: expect.objectContaining({
          rollback: false,
          errorMessage: "disk full",
        }),
      }),
    );
  });

  it("emits cli.migration_failed when rollbackStorage throws", async () => {
    mockRollbackStorage.mockRejectedValue(new Error("rollback boom"));

    await program.parseAsync(["node", "ao", "migrate-storage", "--rollback"]);

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.migration_failed",
        source: "cli",
        level: "error",
        data: expect.objectContaining({
          rollback: true,
          errorMessage: "rollback boom",
        }),
      }),
    );
  });
});
