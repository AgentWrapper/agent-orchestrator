import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileLockSync } from "../file-lock.js";

describe("withFileLockSync", () => {
  let tempRoot: string;
  let lockPath: string;

  beforeEach(() => {
    tempRoot = join(tmpdir(), `ao-file-lock-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempRoot, { recursive: true });
    lockPath = join(tempRoot, "config.lock");
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("serializes parallel holders across processes", async () => {
    const helperPath = join(tempRoot, "lock-holder.mjs");
    const logPath = join(tempRoot, "events.log");
    writeFileSync(
      helperPath,
      [
        `import { appendFileSync } from "node:fs";`,
        `import { withFileLockSync } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/file-lock.ts")).href)};`,
        `const [lockPath, targetLogPath, label, holdMs] = process.argv.slice(2);`,
        `withFileLockSync(lockPath, () => {`,
        `  appendFileSync(targetLogPath, \`start:\${label}\\n\`);`,
        `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));`,
        `  appendFileSync(targetLogPath, \`end:\${label}\\n\`);`,
        `}, { timeoutMs: 5_000, staleMs: 60_000 });`,
      ].join("\n"),
      "utf-8",
    );

    const runHolder = (label: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", helperPath, lockPath, logPath, label, "100"],
          { cwd: process.cwd(), stdio: "inherit" },
        );
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`lock holder ${label} exited with code ${code}`));
        });
      });

    await Promise.all([runHolder("a"), runHolder("b")]);

    const events = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(events).toHaveLength(4);
    expect(events).toSatisfy((lines: string[]) => {
      const [firstStart, firstEnd, secondStart, secondEnd] = lines;
      return (
        (firstStart === "start:a" && firstEnd === "end:a" && secondStart === "start:b" && secondEnd === "end:b") ||
        (firstStart === "start:b" && firstEnd === "end:b" && secondStart === "start:a" && secondEnd === "end:a")
      );
    });
  });

  it("reclaims stale lock files before running the critical section", () => {
    const fd = openSync(lockPath, "w");
    closeSync(fd);
    const staleTime = new Date(Date.now() - 120_000);
    utimesSync(lockPath, staleTime, staleTime);

    const value = withFileLockSync(lockPath, () => "ok", { staleMs: 1_000 });

    expect(value).toBe("ok");
  });

  it("times out when another fresh lock cannot be acquired", () => {
    const fd = openSync(lockPath, "w");

    try {
      expect(() =>
        withFileLockSync(lockPath, () => "never", { timeoutMs: 20, staleMs: 60_000 }),
      ).toThrow(/Timed out waiting for file lock/);
    } finally {
      closeSync(fd);
    }
  });
});
