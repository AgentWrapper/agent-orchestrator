import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  generateProjectId,
  generateSessionName,
  generateSessionPrefix,
  generateTmuxName,
  getArchiveDir,
  getFeedbackReportsDir,
  getOrchestratorPath,
  getOriginFilePath,
  getProjectBaseDir,
  getProjectDir,
  getProjectSessionsDir,
  getProjectWorktreesDir,
  getSessionPath,
  getSessionsDir,
  getWorktreesDir,
  parseTmuxName,
  parseTmuxNameV2,
} from "../paths.js";

describe("paths", () => {
  const storageKey = "aaaaaaaaaaaa";
  const baseDir = join(process.env["HOME"] ?? "", ".agent-orchestrator", storageKey);

  it("returns storage-key scoped directories", () => {
    expect(getProjectBaseDir(storageKey)).toBe(baseDir);
    expect(getSessionsDir(storageKey)).toBe(join(baseDir, "sessions"));
    expect(getWorktreesDir(storageKey)).toBe(join(baseDir, "worktrees"));
    expect(getFeedbackReportsDir(storageKey)).toBe(join(baseDir, "feedback-reports"));
    expect(getArchiveDir(storageKey)).toBe(join(baseDir, "sessions", "archive"));
    expect(getOriginFilePath(storageKey)).toBe(join(baseDir, ".origin"));
  });

  it("keeps session prefix generation unchanged", () => {
    expect(generateSessionPrefix("agent-orchestrator")).toBe("ao");
    expect(generateSessionPrefix("Integrator")).toBe("int");
    expect(generateSessionName("ao", 7)).toBe("ao-7");
  });

  it("uses the storage key as the tmux hash segment", () => {
    const tmuxName = generateTmuxName(storageKey, "ao", 3);
    expect(tmuxName).toBe("aaaaaaaaaaaa-ao-3");
    expect(parseTmuxName(tmuxName)).toEqual({
      hash: storageKey,
      prefix: "ao",
      num: 3,
    });
  });

  it("keeps parseTmuxName strict about the 12-hex storage key", () => {
    expect(parseTmuxName("not-a-key-ao-1")).toBeNull();
    expect(parseTmuxName("abc-ao-1")).toBeNull();
  });
});

describe("V2 paths", () => {
  const home = process.env["HOME"] ?? "";
  const aoBase = join(home, ".agent-orchestrator");

  it("getProjectDir returns projects/{projectId}", () => {
    expect(getProjectDir("my-app")).toBe(join(aoBase, "projects", "my-app"));
  });

  it("getProjectSessionsDir returns projects/{projectId}/sessions", () => {
    expect(getProjectSessionsDir("my-app")).toBe(join(aoBase, "projects", "my-app", "sessions"));
  });

  it("getProjectWorktreesDir returns projects/{projectId}/worktrees", () => {
    expect(getProjectWorktreesDir("my-app")).toBe(join(aoBase, "projects", "my-app", "worktrees"));
  });

  it("getOrchestratorPath returns projects/{projectId}/orchestrator.json", () => {
    expect(getOrchestratorPath("my-app")).toBe(join(aoBase, "projects", "my-app", "orchestrator.json"));
  });

  it("getSessionPath returns projects/{projectId}/sessions/{sessionId}.json", () => {
    expect(getSessionPath("my-app", "ao-7")).toBe(join(aoBase, "projects", "my-app", "sessions", "ao-7.json"));
  });

  it("assertSafeProjectId rejects unsafe project IDs", () => {
    expect(() => getProjectDir("")).toThrow("Unsafe project ID");
    expect(() => getProjectDir(".")).toThrow("Unsafe project ID");
    expect(() => getProjectDir("..")).toThrow("Unsafe project ID");
    expect(() => getProjectDir("foo/bar")).toThrow("Unsafe project ID");
    expect(() => getProjectDir("foo\\bar")).toThrow("Unsafe project ID");
    expect(() => getProjectDir("foo\0bar")).toThrow("Unsafe project ID");
    // Shell-unsafe characters
    expect(() => getProjectDir("my app")).toThrow("Unsafe project ID");
    expect(() => getProjectDir("proj:v2")).toThrow("Unsafe project ID");
    expect(() => getProjectDir("test$var")).toThrow("Unsafe project ID");
    expect(() => getProjectDir("a`b")).toThrow("Unsafe project ID");
    // Starts with dot
    expect(() => getProjectDir("...")).toThrow("Unsafe project ID");
    expect(() => getProjectDir(".hidden")).toThrow("Unsafe project ID");
    // Too long
    expect(() => getProjectDir("a".repeat(129))).toThrow("Unsafe project ID");
  });

  it("accepts valid project IDs", () => {
    expect(() => getProjectDir("my-app")).not.toThrow();
    expect(() => getProjectDir("app_v2")).not.toThrow();
    expect(() => getProjectDir("MyApp.v3")).not.toThrow();
    expect(() => getProjectDir("a".repeat(128))).not.toThrow();
  });
});

describe("generateProjectId", () => {
  it("uses basename of path", () => {
    expect(generateProjectId("/home/user/repos/integrator")).toBe("integrator");
    expect(generateProjectId("~/repos/agent-orchestrator")).toBe("agent-orchestrator");
  });
});

describe("parseTmuxNameV2", () => {
  it("parses V2 format {prefix}-{num}", () => {
    expect(parseTmuxNameV2("ao-84")).toEqual({ prefix: "ao", num: 84 });
    expect(parseTmuxNameV2("my_app-1")).toEqual({ prefix: "my_app", num: 1 });
    expect(parseTmuxNameV2("my-app-1")).toEqual({ prefix: "my-app", num: 1 });
    expect(parseTmuxNameV2("my-app-orchestrator-5")).toEqual({ prefix: "my-app-orchestrator", num: 5 });
    expect(parseTmuxNameV2("123-5")).toEqual({ prefix: "123", num: 5 });
  });

  it("returns null for invalid formats", () => {
    expect(parseTmuxNameV2("")).toBeNull();
    expect(parseTmuxNameV2("ao")).toBeNull();
    expect(parseTmuxNameV2("-5")).toBeNull();
  });
});
