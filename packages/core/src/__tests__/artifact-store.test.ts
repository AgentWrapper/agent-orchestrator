import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as paths from "../paths.js";
import {
  writeCanonicalArtifact,
  readArtifacts,
  readCanonicalArtifactIfExists,
  ARTIFACT_MAX_PER_SESSION,
} from "../artifact-store.js";
import type { Artifact } from "../artifact-schema.js";

let testHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  testHome = await mkdtemp(join(tmpdir(), "ao-artifact-store-"));
  originalHome = process.env.HOME;
  process.env.HOME = testHome;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(testHome, { recursive: true, force: true });
});

function makeArtifact(id: string, updatedAt: string, type: "markdown" = "markdown"): Artifact {
  return {
    version: 1,
    id,
    type,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    source: "agent",
    payload: { markdown: `# ${id}` },
  };
}

describe("writeCanonicalArtifact", () => {
  it("writes an artifact to the canonical location", async () => {
    const artifact = makeArtifact("hello", "2026-05-13T10:00:00.000Z");
    await writeCanonicalArtifact("test-project", "ao-1", artifact);

    const filePath = join(paths.getSessionArtifactsDir("test-project", "ao-1"), "hello.json");
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe("hello");
  });

  it("creates the directory if missing", async () => {
    const artifact = makeArtifact("hello", "2026-05-13T10:00:00.000Z");
    await writeCanonicalArtifact("test-project", "ao-new", artifact);
    const entries = await readdir(paths.getSessionArtifactsDir("test-project", "ao-new"));
    expect(entries).toContain("hello.json");
  });

  it("overwrites an existing artifact at the same id", async () => {
    const v1 = makeArtifact("hello", "2026-05-13T10:00:00.000Z");
    const v2 = { ...v1, title: "Updated", updatedAt: "2026-05-13T11:00:00.000Z" };
    await writeCanonicalArtifact("test-project", "ao-1", v1);
    await writeCanonicalArtifact("test-project", "ao-1", v2);

    const list = await readArtifacts("test-project", "ao-1");
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("Updated");
  });
});

describe("readArtifacts", () => {
  it("returns empty array if directory does not exist", async () => {
    const artifacts = await readArtifacts("test-project", "ao-missing");
    expect(artifacts).toEqual([]);
  });

  it("returns artifacts sorted by updatedAt descending", async () => {
    await writeCanonicalArtifact("p", "s", makeArtifact("a", "2026-05-13T10:00:00.000Z"));
    await writeCanonicalArtifact("p", "s", makeArtifact("b", "2026-05-13T11:00:00.000Z"));
    await writeCanonicalArtifact("p", "s", makeArtifact("c", "2026-05-13T09:00:00.000Z"));

    const list = await readArtifacts("p", "s");
    expect(list.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("skips dotfiles and .staging directory contents", async () => {
    const sessionDir = paths.getSessionArtifactsDir("p", "s");
    await mkdir(join(sessionDir, ".staging"), { recursive: true });
    await writeFile(
      join(sessionDir, ".staging", "queued.json"),
      JSON.stringify(makeArtifact("queued", "2026-05-13T10:00:00.000Z")),
    );
    await writeCanonicalArtifact("p", "s", makeArtifact("real", "2026-05-13T11:00:00.000Z"));

    const list = await readArtifacts("p", "s");
    expect(list.map((c) => c.id)).toEqual(["real"]);
  });

  it("drops files that fail schema validation", async () => {
    const sessionDir = paths.getSessionArtifactsDir("p", "s");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "broken.json"), JSON.stringify({ id: "broken", garbage: true }));
    await writeCanonicalArtifact("p", "s", makeArtifact("ok", "2026-05-13T11:00:00.000Z"));

    const list = await readArtifacts("p", "s");
    expect(list.map((c) => c.id)).toEqual(["ok"]);
  });

  it("drops corrupt JSON without crashing", async () => {
    const sessionDir = paths.getSessionArtifactsDir("p", "s");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "corrupt.json"), "{ not valid json");

    const list = await readArtifacts("p", "s");
    expect(list).toEqual([]);
  });

  it("caps result at ARTIFACT_MAX_PER_SESSION", async () => {
    for (let i = 0; i < ARTIFACT_MAX_PER_SESSION + 5; i++) {
      const ts = new Date(2026, 0, 1, 0, i).toISOString();
      await writeCanonicalArtifact("p", "s", makeArtifact(`c${i}`, ts));
    }
    const list = await readArtifacts("p", "s");
    expect(list.length).toBe(ARTIFACT_MAX_PER_SESSION);
  });
});

describe("readCanonicalArtifactIfExists", () => {
  it("returns the artifact if present", async () => {
    await writeCanonicalArtifact("p", "s", makeArtifact("hello", "2026-05-13T10:00:00.000Z"));
    const artifact = await readCanonicalArtifactIfExists("p", "s", "hello");
    expect(artifact?.id).toBe("hello");
  });

  it("returns null if missing", async () => {
    const artifact = await readCanonicalArtifactIfExists("p", "s", "missing");
    expect(artifact).toBeNull();
  });

  it("returns null if file is corrupt", async () => {
    const sessionDir = paths.getSessionArtifactsDir("p", "s");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "bad.json"), "{ corrupt");
    const artifact = await readCanonicalArtifactIfExists("p", "s", "bad");
    expect(artifact).toBeNull();
  });
});
