import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkActivityLogState,
  classifyTerminalActivity,
  readLastActivityEntry,
  appendActivityEntry,
  recordTerminalActivity,
  getActivityLogPath,
  ACTIVITY_INPUT_STALENESS_MS,
} from "../activity-log.js";
import type { ActivityState } from "../types.js";

describe("classifyTerminalActivity", () => {
  it("returns active state with no trigger", () => {
    const detect = () => "active" as ActivityState;
    const result = classifyTerminalActivity("some output", detect);
    expect(result).toEqual({ state: "active", trigger: undefined });
  });

  it("returns waiting_input with trigger from last 3 lines", () => {
    const detect = () => "waiting_input" as ActivityState;
    const result = classifyTerminalActivity("line1\nline2\nprompt?", detect);
    expect(result.state).toBe("waiting_input");
    expect(result.trigger).toContain("prompt?");
  });

  it("returns blocked with trigger", () => {
    const detect = () => "blocked" as ActivityState;
    const result = classifyTerminalActivity("error occurred", detect);
    expect(result.state).toBe("blocked");
    expect(result.trigger).toBeDefined();
  });
});

describe("checkActivityLogState", () => {
  it("returns null for null input", () => {
    expect(checkActivityLogState(null)).toBeNull();
  });

  it("returns waiting_input when entry is fresh", () => {
    const result = checkActivityLogState({
      entry: { ts: new Date().toISOString(), state: "waiting_input", source: "terminal" },
      modifiedAt: new Date(),
    });
    expect(result?.state).toBe("waiting_input");
  });

  it("returns blocked when entry is fresh", () => {
    const result = checkActivityLogState({
      entry: { ts: new Date().toISOString(), state: "blocked", source: "terminal" },
      modifiedAt: new Date(),
    });
    expect(result?.state).toBe("blocked");
  });

  it("returns null for stale waiting_input entry", () => {
    const staleTs = new Date(Date.now() - ACTIVITY_INPUT_STALENESS_MS - 1000).toISOString();
    const result = checkActivityLogState({
      entry: { ts: staleTs, state: "waiting_input", source: "terminal" },
      modifiedAt: new Date(),
    });
    expect(result).toBeNull();
  });

  it("returns null for non-critical states", () => {
    const result = checkActivityLogState({
      entry: { ts: new Date().toISOString(), state: "active", source: "terminal" },
      modifiedAt: new Date(),
    });
    expect(result).toBeNull();
  });

  it("returns null for invalid entry.ts", () => {
    const result = checkActivityLogState({
      entry: { ts: "not-a-date", state: "waiting_input", source: "terminal" },
      modifiedAt: new Date(),
    });
    expect(result).toBeNull();
  });
});

describe("readLastActivityEntry", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ao-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when file does not exist", async () => {
    const result = await readLastActivityEntry(join(tmpDir, "nonexistent"));
    expect(result).toBeNull();
  });

  it("returns null for empty file", async () => {
    await mkdir(join(tmpDir, ".ao"), { recursive: true });
    await writeFile(getActivityLogPath(tmpDir), "", "utf-8");
    const result = await readLastActivityEntry(tmpDir);
    expect(result).toBeNull();
  });

  it("parses a valid entry", async () => {
    await appendActivityEntry(tmpDir, "active", "terminal");
    const result = await readLastActivityEntry(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.entry.state).toBe("active");
    expect(result!.entry.source).toBe("terminal");
    expect(result!.modifiedAt).toBeInstanceOf(Date);
  });

  it("reads the last entry from multiple lines", async () => {
    await appendActivityEntry(tmpDir, "active", "terminal");
    await appendActivityEntry(tmpDir, "waiting_input", "terminal", "prompt?");
    const result = await readLastActivityEntry(tmpDir);
    expect(result!.entry.state).toBe("waiting_input");
    expect(result!.entry.trigger).toBe("prompt?");
  });

  it("returns null for invalid JSON", async () => {
    await mkdir(join(tmpDir, ".ao"), { recursive: true });
    await writeFile(getActivityLogPath(tmpDir), "not json\n", "utf-8");
    const result = await readLastActivityEntry(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null for invalid state value", async () => {
    await mkdir(join(tmpDir, ".ao"), { recursive: true });
    const bad = JSON.stringify({ ts: new Date().toISOString(), state: "invalid", source: "terminal" });
    await writeFile(getActivityLogPath(tmpDir), bad + "\n", "utf-8");
    const result = await readLastActivityEntry(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null for missing required fields", async () => {
    await mkdir(join(tmpDir, ".ao"), { recursive: true });
    const bad = JSON.stringify({ ts: new Date().toISOString() });
    await writeFile(getActivityLogPath(tmpDir), bad + "\n", "utf-8");
    const result = await readLastActivityEntry(tmpDir);
    expect(result).toBeNull();
  });
});

describe("recordTerminalActivity", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ao-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes activity entry to JSONL", async () => {
    const detect = () => "active" as ActivityState;
    await recordTerminalActivity(tmpDir, "output", detect);
    const result = await readLastActivityEntry(tmpDir);
    expect(result!.entry.state).toBe("active");
    expect(result!.entry.source).toBe("terminal");
  });

  it("writes waiting_input with trigger", async () => {
    const detect = () => "waiting_input" as ActivityState;
    await recordTerminalActivity(tmpDir, "line1\nline2\nprompt?", detect);
    const result = await readLastActivityEntry(tmpDir);
    expect(result!.entry.state).toBe("waiting_input");
    expect(result!.entry.trigger).toBeDefined();
  });

  it("deduplicates same state within 20s", async () => {
    const detect = () => "active" as ActivityState;
    await recordTerminalActivity(tmpDir, "output1", detect);
    await recordTerminalActivity(tmpDir, "output2", detect);

    // Read file directly — should have only 1 line (deduped)
    const { readFile: rf } = await import("node:fs/promises");
    const content = await rf(getActivityLogPath(tmpDir), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it("always writes actionable states even if same", async () => {
    const detect = () => "waiting_input" as ActivityState;
    await recordTerminalActivity(tmpDir, "prompt1", detect);
    await recordTerminalActivity(tmpDir, "prompt2", detect);

    const { readFile: rf } = await import("node:fs/promises");
    const content = await rf(getActivityLogPath(tmpDir), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
  });
});
