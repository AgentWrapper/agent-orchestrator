/**
 * Integration tests for the artifacts pipeline (Stage 7 E2E).
 *
 * Scenario: start the artifact watcher pointing at an isolated
 * `~/.agent-orchestrator` (via $HOME override), have a worker write a
 * staging file the way `ao artifact publish` does, watch the watcher ingest
 * it into the canonical store, and assert the canonical file lands with the
 * expected shape.
 *
 * Requires:
 *   - tmux installed (`isTmuxAvailable`)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSessionArtifactsStagingDir,
  readCanonicalArtifactIfExists,
  startArtifactWatcher,
  type ArtifactEvent,
  type ArtifactWatcher,
} from "@aoagents/ao-core";
import {
  isTmuxAvailable,
  killSessionsByPrefix,
} from "./helpers/tmux.js";
import { sleep } from "./helpers/polling.js";

const SESSION_PREFIX = "ao-inttest-artifact-";
const tmuxOk = await isTmuxAvailable();

describe.skipIf(!tmuxOk)("artifacts pipeline (integration)", () => {
  let homeDir: string;
  let prevHome: string | undefined;
  let prevUserprofile: string | undefined;
  let watcher: ArtifactWatcher | null = null;
  let events: ArtifactEvent[] = [];

  const projectId = "inttest-artifact";
  const sessionId = "inttest-artifact-1";

  beforeAll(async () => {
    await killSessionsByPrefix(SESSION_PREFIX);

    // Isolate AO storage to a tmpdir for the duration of this test.
    homeDir = await mkdtemp(join(tmpdir(), "ao-inttest-artifact-home-"));
    prevHome = process.env["HOME"];
    prevUserprofile = process.env["USERPROFILE"];
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;

    // Pre-create the session artifacts dir so the watcher has something to scan.
    await mkdir(getSessionArtifactsStagingDir(projectId, sessionId), { recursive: true });

    events = [];
    watcher = await startArtifactWatcher({
      baseDir: join(homeDir, ".agent-orchestrator"),
      onEvent: (event) => events.push(event),
    });
  }, 60_000);

  afterAll(async () => {
    if (watcher) await watcher.stop().catch(() => {});
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    if (prevUserprofile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = prevUserprofile;
    if (homeDir) await rm(homeDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it("ingests a staged artifact into the canonical store", async () => {
    // Write a staging file exactly the way `ao artifact publish` does.
    const stagingDir = getSessionArtifactsStagingDir(projectId, sessionId);
    const stagingPath = join(stagingDir, "plan-v1.json");
    const body = {
      id: "plan-v1",
      type: "markdown" as const,
      title: "Plan",
      payload: { markdown: "# Hello\n\n- step 1\n- step 2" },
    };
    await writeFile(stagingPath, JSON.stringify(body, null, 2), "utf-8");

    // Wait for the watcher to pick it up and ingest. The watcher emits a
    // artifact-update once the canonical file lands.
    const deadline = Date.now() + 10_000;
    let canonical = await readCanonicalArtifactIfExists(projectId, sessionId, "plan-v1");
    while (!canonical && Date.now() < deadline) {
      await sleep(100);
      canonical = await readCanonicalArtifactIfExists(projectId, sessionId, "plan-v1");
    }

    expect(canonical).not.toBeNull();
    expect(canonical?.id).toBe("plan-v1");
    expect(canonical?.type).toBe("markdown");
    expect(canonical?.title).toBe("Plan");
    if (canonical?.type === "markdown") {
      expect(canonical.payload.markdown).toContain("Hello");
    }
    expect(canonical?.source).toBe("agent");

    const ingestEvents = events.filter(
      (e) => e.type === "artifact-update" && e.sessionId === sessionId,
    );
    expect(ingestEvents.length).toBeGreaterThan(0);
  }, 30_000);

  it("rejects a reserved core-* id with a validation error", async () => {
    const stagingDir = getSessionArtifactsStagingDir(projectId, sessionId);
    const stagingPath = join(stagingDir, "core-spoof.json");
    const body = {
      id: "core-spoof",
      type: "markdown" as const,
      title: "spoof",
      payload: { markdown: "hi" },
    };
    await writeFile(stagingPath, JSON.stringify(body, null, 2), "utf-8");

    // Wait for the .error sidecar.
    const errorPath = stagingPath.replace(/\.json$/, ".error");
    const deadline = Date.now() + 10_000;
    let errorRaw: string | null = null;
    while (Date.now() < deadline) {
      try {
        errorRaw = await readFile(errorPath, "utf-8");
        break;
      } catch {
        await sleep(100);
      }
    }
    expect(errorRaw).not.toBeNull();
    const parsed = JSON.parse(errorRaw as string);
    const messages = (parsed.issues as { message: string }[]).map((i) => i.message);
    expect(messages.some((m) => m.includes("core-"))).toBe(true);
  }, 30_000);
});
