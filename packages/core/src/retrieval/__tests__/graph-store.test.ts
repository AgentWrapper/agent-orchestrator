import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ensureGraphBuilt, getGraphJsonPath } from "../graph-store.js";

const PROJECT_ID = "retrieval-test-project_dead10cc";

function cleanup() {
  rmSync(join(homedir(), ".agent-orchestrator", "projects", PROJECT_ID), {
    recursive: true,
    force: true,
  });
}

afterEach(cleanup);

describe("ensureGraphBuilt", () => {
  it("fails open (returns false) when the update runner throws", async () => {
    cleanup();
    const ok = await ensureGraphBuilt({
      projectId: PROJECT_ID,
      projectRoot: "/tmp/does-not-matter",
      gitHeadResolver: vi.fn(async () => "sha1"),
      updateRunner: vi.fn(async () => {
        throw new Error("graphify not found");
      }),
    });
    expect(ok).toBe(false);
  });

  it("builds once, then skips re-running the updater when HEAD hasn't moved", async () => {
    cleanup();
    const updateRunner = vi.fn(async (_bin, _root, _mirrorDir) => {
      const graphJsonPath = getGraphJsonPath(PROJECT_ID);
      mkdirSync(join(graphJsonPath, ".."), { recursive: true });
      writeFileSync(graphJsonPath, "{}", "utf-8");
    });
    const gitHeadResolver = vi.fn(async () => "sha-fixed");

    const first = await ensureGraphBuilt({
      projectId: PROJECT_ID,
      projectRoot: "/tmp/does-not-matter",
      gitHeadResolver,
      updateRunner,
    });
    expect(first).toBe(true);
    expect(updateRunner).toHaveBeenCalledTimes(1);
    expect(existsSync(getGraphJsonPath(PROJECT_ID))).toBe(true);

    const second = await ensureGraphBuilt({
      projectId: PROJECT_ID,
      projectRoot: "/tmp/does-not-matter",
      gitHeadResolver,
      updateRunner,
    });
    expect(second).toBe(true);
    expect(updateRunner).toHaveBeenCalledTimes(1); // not called again — HEAD unchanged
  });

  it("re-runs the updater when HEAD moves", async () => {
    cleanup();
    const updateRunner = vi.fn(async () => {
      const graphJsonPath = getGraphJsonPath(PROJECT_ID);
      mkdirSync(join(graphJsonPath, ".."), { recursive: true });
      writeFileSync(graphJsonPath, "{}", "utf-8");
    });
    let sha = "sha-1";
    const gitHeadResolver = vi.fn(async () => sha);

    await ensureGraphBuilt({
      projectId: PROJECT_ID,
      projectRoot: "/tmp/does-not-matter",
      gitHeadResolver,
      updateRunner,
    });
    sha = "sha-2";
    await ensureGraphBuilt({
      projectId: PROJECT_ID,
      projectRoot: "/tmp/does-not-matter",
      gitHeadResolver,
      updateRunner,
    });
    expect(updateRunner).toHaveBeenCalledTimes(2);
  });
});
