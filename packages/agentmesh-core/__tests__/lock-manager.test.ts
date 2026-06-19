import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LockManager } from "../src/lock-manager.js";

describe("LockManager", () => {
  let dir: string;
  let lm: LockManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ao-locks-"));
    lm = new LockManager(dir);
  });

  afterEach(() => {
    lm.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("constructs without throwing (sqlite or in-memory fallback)", () => {
    expect(lm).toBeInstanceOf(LockManager);
  });

  it("acquires a lock and reports the resource as locked", () => {
    const lock = lm.acquire({
      type: "file",
      resource: "src/index.ts",
      owner: "TASK-1",
      duration: 60_000,
      reason: "editing",
    });
    expect(lock).not.toBeNull();
    expect(lm.isLocked("src/index.ts")).toBe(true);
    expect(lm.getActiveLock("src/index.ts")?.owner).toBe("TASK-1");
  });

  it("blocks a different owner from acquiring a held lock", () => {
    lm.acquire({
      type: "file",
      resource: "src/a.ts",
      owner: "TASK-1",
      duration: 60_000,
      reason: "editing",
    });
    const second = lm.acquire({
      type: "file",
      resource: "src/a.ts",
      owner: "TASK-2",
      duration: 60_000,
      reason: "editing",
    });
    expect(second).toBeNull();
    expect(lm.canAcquire("TASK-2", "src/a.ts")).toBe(false);
  });

  it("releases all locks for an owner", () => {
    lm.acquire({
      type: "file",
      resource: "src/a.ts",
      owner: "TASK-1",
      duration: 60_000,
      reason: "x",
    });
    lm.acquire({
      type: "file",
      resource: "src/b.ts",
      owner: "TASK-1",
      duration: 60_000,
      reason: "x",
    });
    expect(lm.releaseAll("TASK-1")).toBe(2);
    expect(lm.getAllActiveLocks()).toHaveLength(0);
  });
});
