import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestStagingFile, type IngestResult } from "../artifact-ingest.js";
import { readArtifacts } from "../artifact-store.js";
import { getSessionArtifactsStagingDir } from "../paths.js";

let testHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  testHome = await mkdtemp(join(tmpdir(), "ao-artifact-ingest-"));
  originalHome = process.env.HOME;
  process.env.HOME = testHome;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(testHome, { recursive: true, force: true });
});

async function writeStaging(
  projectId: string,
  sessionId: string,
  id: string,
  body: object,
): Promise<string> {
  const dir = getSessionArtifactsStagingDir(projectId, sessionId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  await writeFile(path, JSON.stringify(body));
  return path;
}

describe("ingestStagingFile", () => {
  it("validates, stamps metadata, and moves a valid markdown file to canonical", async () => {
    const stagingPath = await writeStaging("p", "s", "hello", {
      id: "hello",
      type: "markdown",
      title: "Hello",
      payload: { markdown: "# Hi" },
    });

    const result: IngestResult = await ingestStagingFile(stagingPath, "p", "s");
    expect(result.kind).toBe("ingested");
    if (result.kind === "ingested") {
      expect(result.artifact.id).toBe("hello");
      expect(result.artifact.source).toBe("agent");
      expect(result.artifact.version).toBe(1);
      expect(new Date(result.artifact.createdAt).getTime()).toBeGreaterThan(0);
      expect(result.artifact.updatedAt).toBe(result.artifact.createdAt); // new artifact
    }

    // staging file is gone, canonical exists
    await expect(stat(stagingPath)).rejects.toThrow();
    const canonical = await readArtifacts("p", "s");
    expect(canonical.map((c) => c.id)).toEqual(["hello"]);
  });

  it("preserves createdAt across updates", async () => {
    const stagingPath = await writeStaging("p", "s", "plan", {
      id: "plan",
      type: "markdown",
      title: "Plan v1",
      payload: { markdown: "v1" },
    });
    const r1 = await ingestStagingFile(stagingPath, "p", "s");
    expect(r1.kind).toBe("ingested");
    const originalCreatedAt = r1.kind === "ingested" ? r1.artifact.createdAt : "";

    await new Promise((r) => setTimeout(r, 10)); // ensure clock moves
    await writeStaging("p", "s", "plan", {
      id: "plan",
      type: "markdown",
      title: "Plan v2",
      payload: { markdown: "v2" },
    });
    const r2 = await ingestStagingFile(
      join(getSessionArtifactsStagingDir("p", "s"), "plan.json"),
      "p",
      "s",
    );
    expect(r2.kind).toBe("ingested");
    if (r2.kind === "ingested") {
      expect(r2.artifact.createdAt).toBe(originalCreatedAt);
      expect(r2.artifact.updatedAt > originalCreatedAt).toBe(true);
      expect(r2.artifact.title).toBe("Plan v2");
    }
  });

  it("writes .error sidecar and leaves staging file on schema failure", async () => {
    const stagingPath = await writeStaging("p", "s", "bad", {
      id: "BAD-CAPS",
      type: "markdown",
      title: "Bad",
      payload: { markdown: "x" },
    });

    const result = await ingestStagingFile(stagingPath, "p", "s");
    expect(result.kind).toBe("error");

    // staging file still there
    const stagingStat = await stat(stagingPath);
    expect(stagingStat.isFile()).toBe(true);

    // .error sidecar written
    const errorPath = stagingPath.replace(/\.json$/, ".error");
    const errorRaw = await readFile(errorPath, "utf-8");
    const errorJson = JSON.parse(errorRaw);
    expect(errorJson.issues).toBeDefined();
    expect(errorJson.at).toBeDefined();
  });

  it("rejects core-* prefix from staging", async () => {
    const stagingPath = await writeStaging("p", "s", "core-fake", {
      id: "core-fake",
      type: "markdown",
      title: "Fake",
      payload: { markdown: "x" },
    });

    const result = await ingestStagingFile(stagingPath, "p", "s");
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.issues[0]?.message).toMatch(/reserved/i);
    }
  });

  it("rejects files exceeding size cap", async () => {
    const stagingPath = await writeStaging("p", "s", "huge", {
      id: "huge",
      type: "markdown",
      title: "X",
      payload: { markdown: "a".repeat(300_000) }, // schema allows 64k → schema reject
    });

    const result = await ingestStagingFile(stagingPath, "p", "s");
    expect(result.kind).toBe("error");
  });

  it("evicts oldest canonical when count exceeds ARTIFACT_MAX_PER_SESSION", async () => {
    // write 33 artifacts via the ingest path
    for (let i = 0; i < 33; i++) {
      const p = await writeStaging("p", "s", `c${i.toString().padStart(2, "0")}`, {
        id: `c${i.toString().padStart(2, "0")}`,
        type: "markdown",
        title: `c${i}`,
        payload: { markdown: `${i}` },
      });
      await ingestStagingFile(p, "p", "s");
      await new Promise((r) => setTimeout(r, 2)); // ensure unique updatedAt
    }

    const list = await readArtifacts("p", "s");
    expect(list.length).toBe(32);
    // c00 (oldest) should have been evicted
    expect(list.find((c) => c.id === "c00")).toBeUndefined();
    expect(list.find((c) => c.id === "c32")).toBeDefined();
  });
});
