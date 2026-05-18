import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startArtifactWatcher, type ArtifactWatcher } from "../artifact-watcher.js";
import { readArtifacts } from "../artifact-store.js";
import { getSessionArtifactsStagingDir } from "../paths.js";

let testHome: string;
let originalHome: string | undefined;
let watcher: ArtifactWatcher | null = null;

beforeEach(async () => {
  testHome = await mkdtemp(join(tmpdir(), "ao-artifact-watcher-"));
  originalHome = process.env.HOME;
  process.env.HOME = testHome;
});

afterEach(async () => {
  if (watcher) {
    await watcher.stop();
    watcher = null;
  }
  process.env.HOME = originalHome;
  await rm(testHome, { recursive: true, force: true });
});

function waitForCondition(
  check: () => Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      if (await check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 30);
    };
    tick();
  });
}

describe("startArtifactWatcher", () => {
  it("ingests a file written after the watcher starts", async () => {
    const events: Array<{ type: string }> = [];
    watcher = await startArtifactWatcher({ onEvent: (e) => events.push(e) });

    const dir = getSessionArtifactsStagingDir("p", "s");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "hello.json"),
      JSON.stringify({
        id: "hello",
        type: "markdown",
        title: "Hi",
        payload: { markdown: "x" },
      }),
    );

    await waitForCondition(async () => (await readArtifacts("p", "s")).length === 1);
    expect(events.some((e) => e.type === "artifact-update")).toBe(true);
  });

  it("emits artifact-error on schema failure", async () => {
    const events: Array<{ type: string }> = [];
    watcher = await startArtifactWatcher({ onEvent: (e) => events.push(e) });

    const dir = getSessionArtifactsStagingDir("p", "s");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "bad.json"),
      JSON.stringify({
        id: "BAD-CAPS",
        type: "markdown",
        title: "Bad",
        payload: { markdown: "x" },
      }),
    );

    await waitForCondition(async () =>
      events.some((e) => e.type === "artifact-error"),
    );
    expect(events.find((e) => e.type === "artifact-error")).toBeDefined();
  });

  it("picks up files that existed before startup", async () => {
    const dir = getSessionArtifactsStagingDir("p", "s");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "preexisting.json"),
      JSON.stringify({
        id: "preexisting",
        type: "markdown",
        title: "Old",
        payload: { markdown: "x" },
      }),
    );

    const events: Array<{ type: string }> = [];
    watcher = await startArtifactWatcher({ onEvent: (e) => events.push(e) });

    await waitForCondition(async () => (await readArtifacts("p", "s")).length === 1);
  });
});
