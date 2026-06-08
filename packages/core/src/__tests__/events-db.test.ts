import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetActivityEventsDbWarningForTests,
  emitActivityEventsDbUnavailableWarning,
  formatActivityEventsDbUnavailableWarning,
} from "../events-db.js";

describe("activity-events DB unavailable warning", () => {
  const originalArgv = process.argv;
  const originalDebug = process.env["AO_DEBUG"];

  beforeEach(() => {
    __resetActivityEventsDbWarningForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env["AO_DEBUG"];
    process.argv = ["node", "ao"];
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalDebug === undefined) {
      delete process.env["AO_DEBUG"];
    } else {
      process.env["AO_DEBUG"] = originalDebug;
    }
    vi.restoreAllMocks();
  });

  it("formats missing native binding errors without the bindings search path", () => {
    const message = formatActivityEventsDbUnavailableWarning(
      new Error(
        "Could not locate the bindings file. Tried:\n → /tmp/build/Release/better_sqlite3.node",
      ),
    );

    expect(message).toBe(
      `[ao] activity-events disabled: better-sqlite3 not compiled for Node ${process.version} (ABI v${process.versions.modules}). Run \`pnpm rebuild better-sqlite3\` or use a supported Node version.`,
    );
    expect(message).not.toContain("Tried:");
    expect(message).not.toContain("/tmp/build/Release");
  });

  it("prints the runtime warning once per process", () => {
    process.env["AO_DEBUG"] = "1";
    const err = new Error(
      "Could not locate the bindings file. Tried:\n → /tmp/better_sqlite3.node",
    );

    emitActivityEventsDbUnavailableWarning(err);
    emitActivityEventsDbUnavailableWarning(err);

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain(
      "activity-events disabled: better-sqlite3 not compiled",
    );
  });

  it("suppresses non-events invocations unless AO_DEBUG=1", () => {
    const err = new Error(
      "Could not locate the bindings file. Tried:\n → /tmp/better_sqlite3.node",
    );

    process.argv = ["node", "ao", "spawn", "demo"];
    emitActivityEventsDbUnavailableWarning(err);
    expect(console.warn).not.toHaveBeenCalled();

    process.argv = ["node", "ao", "events", "stats"];
    emitActivityEventsDbUnavailableWarning(err);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
