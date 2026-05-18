import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestStagingFile } from "../artifact-ingest.js";
import { readArtifacts } from "../artifact-store.js";
import { getSessionArtifactsStagingDir } from "../paths.js";

let testHome: string;
let originalHome: string | undefined;
let originalPlatform: PropertyDescriptor | undefined;

beforeEach(async () => {
  testHome = await mkdtemp(join(tmpdir(), "ao-artifact-win-"));
  originalHome = process.env.HOME;
  process.env.HOME = testHome;

  // Mock process.platform to "win32" for these tests.
  // Per docs/CROSS_PLATFORM.md the platform helpers should still resolve
  // correctly even when AO is running on macOS/Linux during the test run —
  // the implementation must not contain inline `process.platform === "win32"`
  // checks; it should use isWindows() helper which we're mocking the input of.
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
});

afterEach(async () => {
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  process.env.HOME = originalHome;
  await rm(testHome, { recursive: true, force: true });
});

describe("artifact ingest on Windows", () => {
  it("ingests a file when path uses backslash separators", async () => {
    const stagingDir = getSessionArtifactsStagingDir("p", "s");
    await mkdir(stagingDir, { recursive: true });
    const stagingPath = join(stagingDir, "win.json");
    await writeFile(
      stagingPath,
      JSON.stringify({
        id: "win",
        type: "markdown",
        title: "W",
        payload: { markdown: "x" },
      }),
    );

    const result = await ingestStagingFile(stagingPath, "p", "s");
    expect(result.kind).toBe("ingested");

    const artifacts = await readArtifacts("p", "s");
    expect(artifacts.map((c) => c.id)).toContain("win");
  });

  it("path parser tolerates mixed separators", async () => {
    // parseStagingPath is exported from artifact-watcher to make this test
    // meaningful. Construct a Windows-style absolute path (drive letter +
    // backslashes) and verify the parser still extracts projectId/sessionId/
    // artifactId correctly.
    const { parseStagingPath } = await import("../artifact-watcher.js");

    const winPath =
      "C:\\Users\\agent\\.agent-orchestrator\\projects\\proj-abc\\artifacts\\sess-xyz\\.staging\\hello.json";
    const parsed = parseStagingPath(winPath);
    expect(parsed).not.toBeNull();
    expect(parsed?.projectId).toBe("proj-abc");
    expect(parsed?.sessionId).toBe("sess-xyz");
    expect(parsed?.artifactId).toBe("hello");

    // Mixed separators (Git Bash sometimes emits these on Windows).
    const mixedPath =
      "C:/Users/agent/.agent-orchestrator/projects/proj-abc\\artifacts/sess-xyz\\.staging\\hello.json";
    const mixedParsed = parseStagingPath(mixedPath);
    expect(mixedParsed?.projectId).toBe("proj-abc");
    expect(mixedParsed?.sessionId).toBe("sess-xyz");
    expect(mixedParsed?.artifactId).toBe("hello");

    // Returns null for non-staging paths.
    const nonStaging =
      "C:\\Users\\agent\\.agent-orchestrator\\projects\\proj-abc\\artifacts\\sess-xyz\\hello.json";
    expect(parseStagingPath(nonStaging)).toBeNull();
  });
});
