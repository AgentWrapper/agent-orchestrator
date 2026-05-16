import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasRecentCommits } from "../git-activity.js";

describe("hasRecentCommits", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "ao-git-activity-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });
  });

  afterEach(() => {
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns true when a commit exists within the default 60s window", async () => {
    await writeFile(join(repoDir, "a.txt"), "hello");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repoDir });

    expect(await hasRecentCommits(repoDir)).toBe(true);
  });

  it("returns false when no commits have been made", async () => {
    expect(await hasRecentCommits(repoDir)).toBe(false);
  });

  it("returns false when the path is not a git repo", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "ao-git-activity-notrepo-"));
    try {
      expect(await hasRecentCommits(notARepo)).toBe(false);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("respects a custom window — excludes commits outside it, includes them inside it", async () => {
    await writeFile(join(repoDir, "a.txt"), "hello");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    // Backdate the commit by ~2 minutes so a 30s window excludes it but a
    // 10-minute window includes it — this discriminates between "parameter
    // forwarded" and "parameter silently ignored / hardcoded".
    const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
    execFileSync("git", ["commit", "-q", "-m", "two-min-ago"], {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: twoMinAgo,
        GIT_COMMITTER_DATE: twoMinAgo,
      },
    });

    expect(await hasRecentCommits(repoDir, 30)).toBe(false);
    expect(await hasRecentCommits(repoDir, 600)).toBe(true);
  });
});
