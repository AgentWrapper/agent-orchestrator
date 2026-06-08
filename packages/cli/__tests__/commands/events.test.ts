import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const { mockQueryActivityEvents, mockSearchActivityEvents, mockGetActivityEventStats } = vi.hoisted(
  () => ({
    mockQueryActivityEvents: vi.fn(),
    mockSearchActivityEvents: vi.fn(),
    mockGetActivityEventStats: vi.fn(),
  }),
);

vi.mock("@aoagents/ao-core", () => ({
  queryActivityEvents: (...args: unknown[]) => mockQueryActivityEvents(...args),
  searchActivityEvents: (...args: unknown[]) => mockSearchActivityEvents(...args),
  getActivityEventStats: (...args: unknown[]) => mockGetActivityEventStats(...args),
  droppedEventCount: () => 0,
  isActivityEventsFtsEnabled: () => true,
}));

import { registerEvents } from "../../src/commands/events.js";

describe("events command", () => {
  let program: Command;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerEvents(program);

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockQueryActivityEvents.mockReset();
    mockSearchActivityEvents.mockReset();
    mockGetActivityEventStats.mockReset();
    mockQueryActivityEvents.mockReturnValue([]);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it("filters list output by source and --kind alias", async () => {
    await program.parseAsync([
      "node",
      "test",
      "events",
      "list",
      "--source",
      "recovery",
      "--kind",
      "metadata.corrupt_detected",
      "--limit",
      "1",
      "--json",
    ]);

    expect(mockQueryActivityEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "recovery",
        kind: "metadata.corrupt_detected",
        limit: 1,
      }),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('"source": "recovery"'));
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('"kind": "metadata.corrupt_detected"'),
    );
  });

  it("keeps --type as the existing event-kind filter", async () => {
    await program.parseAsync([
      "node",
      "test",
      "events",
      "list",
      "--type",
      "recovery.session_failed",
      "--json",
    ]);

    expect(mockQueryActivityEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "recovery.session_failed",
      }),
    );
  });
});
