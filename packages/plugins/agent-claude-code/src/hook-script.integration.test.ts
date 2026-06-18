import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isWindows } from "@aoagents/ao-core";
import { METADATA_UPDATER_SCRIPT, METADATA_UPDATER_SCRIPT_NODE } from "./index.js";

// ---------------------------------------------------------------------------
// Integration tests for the metadata-updater.sh hook script.
// These execute the actual bash script with various inputs and verify that
// session metadata files are updated correctly.
// ---------------------------------------------------------------------------

let testDir: string;
let hookScriptPath: string;
let hookCommand: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "ao-hook-test-"));
  if (isWindows()) {
    hookScriptPath = join(testDir, "metadata-updater.cjs");
    hookCommand = `node "${hookScriptPath}"`;
    writeFileSync(hookScriptPath, METADATA_UPDATER_SCRIPT_NODE, "utf-8");
  } else {
    hookScriptPath = join(testDir, "metadata-updater.sh");
    hookCommand = `bash "${hookScriptPath}"`;
    writeFileSync(hookScriptPath, METADATA_UPDATER_SCRIPT, { mode: 0o755 });
  }
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/**
 * Run the hook script with given parameters and return the script's
 * stdout plus the updated metadata file contents.
 */
function runHook(opts: {
  command: string;
  toolName?: string;
  output?: string;
  exitCode?: number;
  metadataContent?: string;
}): { stdout: string; metadata: string } {
  const sessionId = `test-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionsDir = join(testDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const metadataFile = join(sessionsDir, sessionId);
  writeFileSync(metadataFile, opts.metadataContent ?? "status=spawning\n");

  const input = JSON.stringify({
    tool_name: opts.toolName ?? "Bash",
    tool_input: { command: opts.command },
    tool_response: opts.output ?? "",
    exit_code: opts.exitCode ?? 0,
  });

  let stdout: string;
  try {
    stdout = execSync(hookCommand, {
      input,
      env: {
        ...process.env,
        AO_SESSION: sessionId,
        AO_DATA_DIR: sessionsDir,
        HOME: testDir,
      },
      encoding: "utf-8",
      timeout: 5000,
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string };
    stdout = e.stdout ?? "";
  }

  let metadata: string;
  try {
    metadata = readFileSync(metadataFile, "utf-8");
  } catch {
    metadata = "";
  }

  return { stdout, metadata };
}

// =========================================================================
// gh pr create detection
// =========================================================================
describe("hook script: gh pr create", () => {
  const prUrl = "https://github.com/owner/repo/pull/42";

  it("detects plain gh pr create", () => {
    const { metadata } = runHook({
      command: 'gh pr create --title "fix" --body "test" --base master',
      output: `Creating pull request...\n${prUrl}\n`,
    });
    expect(metadata).toContain(`pr=${prUrl}`);
    expect(metadata).toContain("status=pr_open");
  });

  it("detects gh pr create with cd && prefix", () => {
    const { metadata } = runHook({
      command: `cd ~/.worktrees/mercury/cleanup && gh pr create --title "fix" --base master`,
      output: `${prUrl}`,
    });
    expect(metadata).toContain(`pr=${prUrl}`);
    expect(metadata).toContain("status=pr_open");
  });

  it("detects gh pr create with cd ; prefix", () => {
    const { metadata } = runHook({
      command: `cd /some/path ; gh pr create --title "test" --body "body"`,
      output: prUrl,
    });
    expect(metadata).toContain(`pr=${prUrl}`);
    expect(metadata).toContain("status=pr_open");
  });

  it("detects gh pr create with multiple chained cd prefixes", () => {
    const { metadata } = runHook({
      command: `cd /tmp && cd ~/.worktrees/mercury && gh pr create --title "fix" --base master`,
      output: prUrl,
    });
    expect(metadata).toContain(`pr=${prUrl}`);
    expect(metadata).toContain("status=pr_open");
  });

  it("does NOT update metadata when PR URL is missing from output", () => {
    const { metadata } = runHook({
      command: 'gh pr create --title "fix"',
      output: "Error: something went wrong",
    });
    expect(metadata).not.toContain("pr=");
    expect(metadata).toContain("status=spawning");
  });
});

// =========================================================================
// git checkout -b / git switch -c detection
// =========================================================================
describe("hook script: git checkout -b / git switch -c", () => {
  it("detects plain git checkout -b", () => {
    const { metadata } = runHook({
      command: "git checkout -b feat/my-feature",
    });
    expect(metadata).toContain("branch=feat/my-feature");
  });

  it("detects plain git switch -c", () => {
    const { metadata } = runHook({
      command: "git switch -c fix/bug-123",
    });
    expect(metadata).toContain("branch=fix/bug-123");
  });

  it("detects git checkout -b with cd && prefix", () => {
    const { metadata } = runHook({
      command: "cd /some/project && git checkout -b feat/new-feature",
    });
    expect(metadata).toContain("branch=feat/new-feature");
  });

  it("detects git switch -c with cd && prefix", () => {
    const { metadata } = runHook({
      command: "cd ~/.worktrees/project && git switch -c fix/issue-456",
    });
    expect(metadata).toContain("branch=fix/issue-456");
  });

  it("detects git checkout -b with cd ; prefix", () => {
    const { metadata } = runHook({
      command: "cd /project ; git checkout -b feat/semicolon-test",
    });
    expect(metadata).toContain("branch=feat/semicolon-test");
  });

  it("detects git checkout -b with multiple cd prefixes", () => {
    const { metadata } = runHook({
      command: "cd /tmp && cd /project && git checkout -b feat/chained",
    });
    expect(metadata).toContain("branch=feat/chained");
  });
});

// =========================================================================
// gh pr merge detection
// =========================================================================
describe("hook script: gh pr merge", () => {
  it("detects plain gh pr merge", () => {
    const { metadata } = runHook({
      command: "gh pr merge 123 --squash",
    });
    expect(metadata).toContain("status=merged");
  });

  it("detects gh pr merge with cd && prefix", () => {
    const { metadata } = runHook({
      command: "cd ~/.worktrees/project && gh pr merge 42 --squash",
    });
    expect(metadata).toContain("status=merged");
  });

  it("detects gh pr merge with cd ; prefix", () => {
    const { metadata } = runHook({
      command: "cd /project ; gh pr merge --rebase",
    });
    expect(metadata).toContain("status=merged");
  });
});

// =========================================================================
// git checkout <existing-branch> detection (feature branches)
// =========================================================================
describe("hook script: git checkout existing branch", () => {
  it("detects plain git checkout of a feature branch", () => {
    const { metadata } = runHook({
      command: "git checkout feat/existing-branch",
    });
    expect(metadata).toContain("branch=feat/existing-branch");
  });

  it("detects git checkout of a feature branch with cd prefix", () => {
    const { metadata } = runHook({
      command: "cd /project && git checkout feat/existing-branch",
    });
    expect(metadata).toContain("branch=feat/existing-branch");
  });
});

// =========================================================================
// Non-matching commands (should NOT modify metadata)
// =========================================================================
describe("hook script: non-matching commands", () => {
  it("ignores plain ls command", () => {
    const { metadata } = runHook({
      command: "ls -la",
    });
    expect(metadata).toBe("status=spawning\n");
  });

  it("ignores non-Bash tool calls", () => {
    const { metadata } = runHook({
      command: 'gh pr create --title "test"',
      toolName: "Read",
      output: "https://github.com/owner/repo/pull/1",
    });
    expect(metadata).toBe("status=spawning\n");
  });

  it("ignores commands with non-zero exit code", () => {
    const { metadata } = runHook({
      command: 'gh pr create --title "test"',
      exitCode: 1,
      output: "https://github.com/owner/repo/pull/1",
    });
    expect(metadata).toBe("status=spawning\n");
  });

  it("ignores cd-only commands (no chained git/gh)", () => {
    const { metadata } = runHook({
      command: "cd /some/directory",
    });
    expect(metadata).toBe("status=spawning\n");
  });

  it("ignores git status", () => {
    const { metadata } = runHook({
      command: "cd /project && git status",
    });
    expect(metadata).toBe("status=spawning\n");
  });
});

// =========================================================================
// Metadata file update mechanics
// =========================================================================
describe("hook script: metadata file updates", () => {
  it("updates an existing key in the metadata file", () => {
    const { metadata } = runHook({
      command: "gh pr merge 10 --squash",
      metadataContent: "status=pr_open\nbranch=feat/test\n",
    });
    expect(metadata).toContain("status=merged");
    expect(metadata).toContain("branch=feat/test");
    expect(metadata).not.toContain("status=pr_open");
  });

  it("appends a new key to the metadata file", () => {
    const { metadata } = runHook({
      command: 'gh pr create --title "test"',
      output: "https://github.com/owner/repo/pull/99",
      metadataContent: "branch=feat/test\n",
    });
    expect(metadata).toContain("branch=feat/test");
    expect(metadata).toContain("pr=https://github.com/owner/repo/pull/99");
    expect(metadata).toContain("status=pr_open");
  });

  it("returns systemMessage JSON on successful detection", () => {
    const { stdout } = runHook({
      command: "gh pr merge 1 --squash",
    });
    expect(stdout).toContain("systemMessage");
    expect(stdout).toContain("merged");
  });

  it("returns empty JSON for non-matching commands", () => {
    const { stdout } = runHook({
      command: "echo hello",
    });
    expect(stdout.trim()).toBe("{}");
  });
});
