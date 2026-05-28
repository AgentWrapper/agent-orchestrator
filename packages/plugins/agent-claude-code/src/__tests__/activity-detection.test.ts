import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toClaudeProjectPath, create } from "../index.js";
import { resetWarnedReaddirPaths } from "../activity-detection.js";
import {
  createActivitySignal,
  type ActivityState,
  type Session,
  type RuntimeHandle,
} from "@aoagents/ao-core";

// Mock homedir() so getActivityState looks in our temp dir
vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

let fakeHome: string;
let workspacePath: string;
let projectDir: string;

function makeSession(overrides: Partial<Session> = {}): Session {
  const handle: RuntimeHandle = { id: "test-1", runtimeName: "tmux", data: {} };
  return {
    id: "test-1",
    projectId: "test",
    status: "working",
    activity: "idle",
    activitySignal: createActivitySignal("valid", {
      activity: "idle",
      timestamp: new Date(),
      source: "native",
    }),
    branch: "main",
    issueId: null,
    pr: null,
    prs: [],
    workspacePath,
    runtimeHandle: handle,
    agentInfo: null,
    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day ago (well before any JSONL entries)
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function writeJsonl(
  entries: Array<{ type: string; [key: string]: unknown }>,
  ageMs = 0,
  filename = "session-abc.jsonl",
): void {
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const filePath = join(projectDir, filename);
  writeFileSync(filePath, content);
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    utimesSync(filePath, past, past);
  }
}

function writeActivityLog(
  state: ActivityState,
  ageMs = 0,
  source: "terminal" | "native" | "hook" = "terminal",
  trigger?: string,
): void {
  const ts = new Date(Date.now() - ageMs).toISOString();
  const aoDir = join(workspacePath, ".ao");
  mkdirSync(aoDir, { recursive: true });
  const entry: Record<string, unknown> = { ts, state, source };
  if (trigger !== undefined) entry.trigger = trigger;
  writeFileSync(
    join(aoDir, "activity.jsonl"),
    JSON.stringify(entry) + "\n",
  );
}

// =============================================================================
// toClaudeProjectPath
// =============================================================================

describe("Claude Code Activity Detection", () => {
  describe("toClaudeProjectPath", () => {
    it("encodes paths with leading dash", () => {
      expect(toClaudeProjectPath("/Users/dev/.worktrees/ao")).toBe("-Users-dev--worktrees-ao");
    });

    it("preserves leading slash as leading dash", () => {
      expect(toClaudeProjectPath("/tmp/test")).toBe("-tmp-test");
    });

    it("replaces dots with dashes", () => {
      expect(toClaudeProjectPath("/path/to/.hidden")).toBe("-path-to--hidden");
    });

    it("handles Windows paths (no leading slash)", () => {
      expect(toClaudeProjectPath("C:\\Users\\dev\\project")).toBe("C--Users-dev-project");
    });

    it("handles consecutive dots and slashes", () => {
      // /a/../b/./c → -a-  -- -b- - -c → -a----b---c
      expect(toClaudeProjectPath("/a/../b/./c")).toBe("-a----b---c");
    });

    it("handles paths with multiple dot-directories", () => {
      expect(toClaudeProjectPath("/Users/dev/.config/.local/share")).toBe(
        "-Users-dev--config--local-share",
      );
    });
  });

  // =============================================================================
  // getActivityState — integration tests with real JSONL files on disk
  // =============================================================================

  describe("getActivityState", () => {
    const agent = create();

    beforeEach(() => {
      // realpathSync because /var/folders/... is a symlink to /private/var/folders/...
      // on macOS. getClaudeActivityState resolves symlinks before slugifying (so the
      // slug matches what Claude wrote), so the test setup must do the same — otherwise
      // the test JSONL lives under one slug and the code looks under another.
      // homedir() is mocked to fakeHome, so its realpath flows through naturally.
      fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "ao-activity-test-")));
      workspacePath = join(fakeHome, "workspace");
      mkdirSync(workspacePath, { recursive: true });

      // Create the Claude project directory matching the workspace path
      const encoded = toClaudeProjectPath(workspacePath);
      projectDir = join(fakeHome, ".claude", "projects", encoded);
      mkdirSync(projectDir, { recursive: true });

      // Mock isProcessRunning to always return true (we test exited separately)
      vi.spyOn(agent, "isProcessRunning").mockResolvedValue(true);

      // Reset module-level warn dedupe so each test starts fresh.
      resetWarnedReaddirPaths();
    });

    afterEach(() => {
      rmSync(fakeHome, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    // -----------------------------------------------------------------------
    // Process / handle edge cases
    // -----------------------------------------------------------------------

    it("returns 'exited' when process is not running", async () => {
      vi.spyOn(agent, "isProcessRunning").mockResolvedValue(false);
      writeJsonl([{ type: "assistant" }]);
      expect((await agent.getActivityState(makeSession()))?.state).toBe("exited");
    });

    it("returns 'exited' when no runtimeHandle", async () => {
      expect((await agent.getActivityState(makeSession({ runtimeHandle: undefined })))?.state).toBe(
        "exited",
      );
    });

    it("returns 'exited' when runtimeHandle is null", async () => {
      expect((await agent.getActivityState(makeSession({ runtimeHandle: null })))?.state).toBe("exited");
    });

    // -----------------------------------------------------------------------
    // Fallback cases (no JSONL data available)
    // -----------------------------------------------------------------------

    it("returns null when no session file or AO activity entry exists yet", async () => {
      // projectDir exists but is empty, and the AO safety-net log is absent.
      expect(await agent.getActivityState(makeSession())).toBeNull();
    });

    it("returns null when no workspacePath", async () => {
      expect(await agent.getActivityState(makeSession({ workspacePath: null }))).toBeNull();
    });

    it("logs a warning when ~/.claude/projects/<dir> is unreadable (EACCES)", async () => {
      // Make the existing project dir unreadable by stripping owner-read.
      // ENOENT (dir missing) is normal and stays silent; EACCES/EPERM must
      // surface so users can debug a silent-idle session.
      const { chmodSync } = await import("node:fs");
      chmodSync(projectDir, 0o000);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await agent.getActivityState(makeSession());
        expect(result).toBeNull();
        expect(warn).toHaveBeenCalledOnce();
        // Non-capturing group: alternation MUST stay inside `(?:...)` or it
        // would parse as `(failed to read.*EACCES) | (EPERM)` and any string
        // containing the literal `EPERM` would pass the assertion.
        expect(warn.mock.calls[0]?.[0]).toMatch(/failed to read.*(?:EACCES|EPERM)/);
      } finally {
        chmodSync(projectDir, 0o755);
        warn.mockRestore();
      }
    });

    it("only warns ONCE per path across multiple polls (no log flood)", async () => {
      // Real bug this guards against: getActivityState runs on a polling
      // interval; without the dedupe set, a single EACCES path would log
      // 60+ lines/minute indefinitely.
      const { chmodSync } = await import("node:fs");
      chmodSync(projectDir, 0o000);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await agent.getActivityState(makeSession());
        await agent.getActivityState(makeSession());
        await agent.getActivityState(makeSession());
        expect(warn).toHaveBeenCalledOnce();
      } finally {
        chmodSync(projectDir, 0o755);
        warn.mockRestore();
      }
    });

    it("does NOT log when project dir simply doesn't exist (ENOENT is normal)", async () => {
      const badPath = join(fakeHome, "this-workspace-never-existed");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await agent.getActivityState(makeSession({ workspacePath: badPath }));
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it("prefers UUID-named JSONL when session.metadata.claudeSessionUuid is set", async () => {
      // Multi-session-in-one-worktree case: two .jsonl files exist, the
      // newest-mtime one is from a DIFFERENT session, and we don't want
      // to misread that. Use the metadata UUID to pick the right one.
      const myUuid = "aaa-111";
      // Newest-mtime file is the OTHER session's JSONL (would be wrong).
      writeJsonl([{ type: "progress", status: "doing other work" }], 0, "bbb-222.jsonl");
      // My session's JSONL is older, but it's the one we want.
      writeJsonl(
        [{ type: "assistant", message: { content: "my session" } }],
        10_000,
        `${myUuid}.jsonl`,
      );

      const session = makeSession({ metadata: { claudeSessionUuid: myUuid } });
      const result = await agent.getActivityState(session);
      // 10s old + `assistant` → ready (NOT `active` from the other session's progress)
      expect(result?.state).toBe("ready");
    });

    it("falls back to newest-mtime when UUID-named file doesn't exist yet", async () => {
      // Session just spawned, getSessionInfo hasn't captured the UUID yet,
      // OR the UUID was captured but the file was rotated/removed.
      // Should still find activity via newest-mtime fallback.
      writeJsonl([{ type: "user", message: { content: "hi" } }], 0, "actual-session.jsonl");

      const session = makeSession({ metadata: { claudeSessionUuid: "uuid-that-doesnt-exist" } });
      const result = await agent.getActivityState(session);
      expect(result?.state).toBe("active");
    });

    it("resolves symlinked workspace paths so slugs match what Claude wrote", async () => {
      // Claude resolves the symlink target before slugifying. If AO records
      // the symlink path and slugifies without realpath, the two slugs
      // diverge and findLatestSessionFile returns null forever. This test
      // confirms the realpath fix: write JSONL under the SLUG OF THE TARGET,
      // call getActivityState with the SYMLINK PATH, expect to find it.
      const { symlinkSync } = await import("node:fs");
      const target = workspacePath; // the real workspace dir
      const link = join(fakeHome, "symlinked-workspace");
      symlinkSync(target, link);

      // JSONL is already in projectDir (which slugifies the real path).
      writeJsonl([{ type: "assistant", message: { content: "Done!" } }]);

      // Calling with the SYMLINK should still find the file because of realpath.
      const result = await agent.getActivityState(makeSession({ workspacePath: link }));
      expect(result?.state).toBe("ready");
    });

    it("returns null when project directory does not exist and AO activity is unavailable", async () => {
      const badPath = join(fakeHome, "nonexistent-workspace");
      expect(await agent.getActivityState(makeSession({ workspacePath: badPath }))).toBeNull();
    });

    it("recordActivity is intentionally not implemented (#1941 — hooks write activity-JSONL directly)", () => {
      // Lifecycle manager calls agent.recordActivity? only if defined.
      // For Claude, hooks are the source of truth so this method is
      // omitted — guarding here surfaces accidental re-introduction.
      expect(agent.recordActivity).toBeUndefined();
    });

    it("does NOT write to .ao/activity.jsonl on its own (hook-only producer)", () => {
      // Without recordActivity, the plugin no longer derives anything from
      // terminal output. .ao/activity.jsonl stays empty until a hook fires.
      expect(existsSync(join(workspacePath, ".ao", "activity.jsonl"))).toBe(false);
    });

    it("keeps native JSONL as primary when AO activity JSONL also exists", async () => {
      writeJsonl([{ type: "assistant", message: { content: "Done!" } }]);
      writeActivityLog("waiting_input");

      expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
    });

    it("falls back to AO JSONL waiting_input when native session lookup is unavailable (#1941 hook entry)", async () => {
      // PermissionRequest hook fires → activity-updater appends a JSONL entry
      // with source: "hook". The cascade picks it up exactly like the old
      // terminal-derived entry.
      writeActivityLog("waiting_input", 0, "hook", "PermissionRequest (Bash)");

      expect((await agent.getActivityState(makeSession()))?.state).toBe("waiting_input");
    });

    it("falls back to AO JSONL waiting_input when native session entry predates this session", async () => {
      writeJsonl([{ type: "assistant", message: { content: "Previous session done" } }], 120_000);
      const session = makeSession({ createdAt: new Date() });

      writeActivityLog("waiting_input", 0, "hook", "PermissionRequest");

      expect((await agent.getActivityState(session))?.state).toBe("waiting_input");
    });

    it("surfaces blocked from a StopFailure hook entry in AO JSONL", async () => {
      // StopFailure → activity-updater appends `{state: blocked, source: hook,
      // trigger: "StopFailure (rate_limit)"}`. With no Claude native JSONL
      // present, the cascade must surface it through checkActivityLogState.
      writeActivityLog("blocked", 0, "hook", "StopFailure (rate_limit)");

      const result = await agent.getActivityState(makeSession());
      expect(result?.state).toBe("blocked");
    });

    it("returns idle for stale native session entry when AO JSONL is unavailable", async () => {
      writeJsonl([{ type: "assistant", message: { content: "Previous session done" } }], 120_000);
      const session = makeSession({ createdAt: new Date() });

      const result = await agent.getActivityState(session);

      expect(result?.state).toBe("idle");
      expect(result?.timestamp).toBe(session.createdAt);
    });

    it("falls back to AO JSONL age-decay when native session lookup is unavailable", async () => {
      writeActivityLog("active", 400_000);

      expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
    });

    // -----------------------------------------------------------------------
    // Real Claude Code entry types (observed in production)
    // -----------------------------------------------------------------------

    describe("real Claude Code entry types", () => {
      it("returns 'active' for recent 'progress' entry (streaming)", async () => {
        writeJsonl([{ type: "progress", status: "running tool" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });

      it("returns 'active' for recent 'user' entry", async () => {
        writeJsonl([{ type: "user", message: { content: "fix the bug" } }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });

      it("returns 'ready' for recent 'assistant' entry", async () => {
        writeJsonl([{ type: "assistant", message: { content: "Done!" } }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("returns 'ready' for recent 'system' entry", async () => {
        writeJsonl([{ type: "system", summary: "session started" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("returns 'blocked' for 'system' api_error (level: error)", async () => {
        writeJsonl([
          {
            type: "system",
            subtype: "api_error",
            level: "error",
            cause: { code: "ConnectionRefused" },
          },
        ]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("blocked");
      });

      it("returns 'ready' for non-error 'system' subtypes (compact_boundary)", async () => {
        writeJsonl([{ type: "system", subtype: "compact_boundary", level: "info" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("requires BOTH api_error subtype AND error level for 'blocked'", async () => {
        // A future error-level diagnostic that isn't api_error must NOT be
        // silently classified as blocked.
        writeJsonl([{ type: "system", subtype: "future_diagnostic", level: "error" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      // Bookkeeping types Claude writes AFTER finishing a turn — these are
      // turn-end markers, not "Claude is working" signals. They must map to
      // ready/idle by age, NOT active. Previously they fell through to the
      // default branch and looked "active" for 30s; fixed in this PR.
      it("returns 'ready' for recent 'file-history-snapshot' (bookkeeping)", async () => {
        writeJsonl([{ type: "file-history-snapshot" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("returns 'ready' for recent 'queue-operation' (bookkeeping)", async () => {
        writeJsonl([{ type: "queue-operation" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("returns 'idle' (not 'ready') for recent 'pr-link' — re-snapshot noise", async () => {
        // Empirical evidence (ao-160): the SAME PR (#1911) was written as
        // pr-link 33 times in the last 200 lines, with new timestamps each
        // time. It's a periodic state snapshot, not a one-shot event.
        // Treat as noise so dormant sessions don't show as "ready" forever.
        writeJsonl([
          {
            type: "pr-link",
            prNumber: 1911,
            prUrl: "https://github.com/owner/repo/pull/1911",
          },
        ]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("returns 'ready' for recent 'attachment' (bookkeeping)", async () => {
        writeJsonl([{ type: "attachment", attachment: { type: "skill_listing" } }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      // Pure UI-noise types (permission-mode, ai-title, agent-*, custom-title)
      // are written by Claude at random times (session attach, mode change,
      // title gen) and don't reflect actual activity. Real-world repro:
      // ao-144 had 73 trailing permission-mode + 73 trailing ai-title entries
      // over 6 dormant days, causing the dashboard to oscillate between
      // ready and idle. They now fall through to the AO JSONL pipeline; if
      // that has nothing, the stale-native fallback returns idle from
      // session.createdAt.
      it("returns 'idle' (not 'ready') for recent permission-mode noise — dormant session", async () => {
        writeJsonl([{ type: "permission-mode", permissionMode: "bypassPermissions" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("returns 'idle' (not 'ready') for recent ai-title noise — dormant session", async () => {
        writeJsonl([{ type: "ai-title", title: "Fix login bug" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("returns 'idle' for agent-color / agent-name / custom-title noise", async () => {
        writeJsonl([{ type: "agent-color", color: "#fff" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
        writeJsonl([{ type: "agent-name", name: "ao-161" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
        writeJsonl([{ type: "custom-title", title: "x" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("noise last entry yields to AO JSONL when AO has actionable state", async () => {
        // Repro of the scenario where Claude IS active but the latest native
        // JSONL line happens to be noise. Native JSONL gets skipped, AO
        // activity JSONL has waiting_input from a recent terminal scrape,
        // cascade returns waiting_input.
        writeJsonl([{ type: "permission-mode" }]);
        writeActivityLog("waiting_input");
        expect((await agent.getActivityState(makeSession()))?.state).toBe("waiting_input");
      });
    });

    // -----------------------------------------------------------------------
    // Agent interface spec types (may appear in future versions)
    // -----------------------------------------------------------------------

    describe("agent interface spec types", () => {
      it("returns 'ready' for recent 'summary' entry", async () => {
        writeJsonl([{ type: "summary", summary: "Implemented login feature" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("unknown types fall through to default branch — fresh → active", async () => {
        // Claude doesn't emit `tool_use` or `result` as top-level types (verified
        // on disk for #1927). Their explicit switch cases were removed and they
        // now fall to `default`, which maps fresh unknown types to active. This
        // test locks the default-branch semantics so future Claude type
        // additions are handled predictably until someone adds an explicit case.
        writeJsonl([{ type: "some-future-claude-type" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });
    });

    // -----------------------------------------------------------------------
    // Staleness / threshold behavior
    // -----------------------------------------------------------------------

    describe("staleness threshold", () => {
      it("returns 'idle' for stale 'assistant' entry (> threshold)", async () => {
        writeJsonl([{ type: "assistant" }], 400_000); // 6+ min old
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("returns 'idle' for stale 'user' entry (> threshold)", async () => {
        writeJsonl([{ type: "user" }], 400_000);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("returns 'idle' for stale 'progress' entry (> threshold)", async () => {
        writeJsonl([{ type: "progress" }], 400_000);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("returns 'idle' for stale bookkeeping entry (> threshold)", async () => {
        writeJsonl([{ type: "file-history-snapshot" }], 400_000);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("'system' api_error ignores staleness (always blocked)", async () => {
        writeJsonl(
          [{ type: "system", subtype: "api_error", level: "error" }],
          400_000,
        );
        expect((await agent.getActivityState(makeSession()))?.state).toBe("blocked");
      });

      it("respects custom readyThresholdMs", async () => {
        // 2 minutes old — stale with 60s threshold, ready with default 5min
        writeJsonl([{ type: "assistant" }], 120_000);

        expect((await agent.getActivityState(makeSession(), 60_000))?.state).toBe("idle");
        expect((await agent.getActivityState(makeSession(), 300_000))?.state).toBe("ready");
      });

      it("custom threshold applies to active types too", async () => {
        // 2 minutes old — past active window (30s), within 300s threshold → ready
        writeJsonl([{ type: "user" }], 120_000);

        expect((await agent.getActivityState(makeSession(), 60_000))?.state).toBe("idle");
        expect((await agent.getActivityState(makeSession(), 300_000))?.state).toBe("ready");
      });

      it("active types within 30s window return active", async () => {
        // 10 seconds old — within active window → active
        writeJsonl([{ type: "user" }], 10_000);

        expect((await agent.getActivityState(makeSession(), 300_000))?.state).toBe("active");
      });
    });

    // -----------------------------------------------------------------------
    // JSONL file selection
    // -----------------------------------------------------------------------

    describe("JSONL file selection", () => {
      it("picks the most recently modified JSONL file", async () => {
        // Write an older file with "assistant" and a newer file with "user"
        writeJsonl([{ type: "assistant" }], 10_000, "old-session.jsonl");
        writeJsonl([{ type: "user" }], 0, "new-session.jsonl");

        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });

      it("ignores agent- prefixed JSONL files", async () => {
        writeJsonl([{ type: "user" }], 0, "agent-toolkit.jsonl");
        // No real session file and no AO activity fallback.
        expect(await agent.getActivityState(makeSession())).toBeNull();
      });

      it("reads last entry from multi-entry JSONL (not first)", async () => {
        // First entry is user (active), last entry is assistant (ready)
        writeJsonl([
          { type: "user", message: { content: "fix bug" } },
          { type: "progress", status: "thinking" },
          { type: "assistant", message: { content: "Done!" } },
        ]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("returns null for empty JSONL file", async () => {
        writeFileSync(join(projectDir, "empty-session.jsonl"), "");
        expect(await agent.getActivityState(makeSession())).toBeNull();
      });

      it("returns null for JSONL with only whitespace", async () => {
        writeFileSync(join(projectDir, "whitespace-session.jsonl"), "\n\n  \n");
        // All lines are whitespace — readLastJsonlEntry returns null
        expect(await agent.getActivityState(makeSession())).toBeNull();
      });

      it("ignores non-JSONL files in project directory", async () => {
        // Write a non-JSONL file
        writeFileSync(join(projectDir, "config.json"), '{"type": "user"}');
        writeFileSync(join(projectDir, "notes.txt"), "some notes");
        // Write actual JSONL
        writeJsonl([{ type: "assistant" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });
    });

    // -----------------------------------------------------------------------
    // Realistic session sequences
    // -----------------------------------------------------------------------

    describe("realistic session sequences", () => {
      it("detects agent mid-work (progress is last entry)", async () => {
        writeJsonl([
          { type: "user", message: { content: "implement auth" } },
          { type: "assistant", message: { content: "I'll implement..." } },
          { type: "progress", status: "Reading file" },
          { type: "progress", status: "Writing file" },
          { type: "progress", status: "Running tool" },
        ]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });

      it("detects agent done and waiting (assistant is last entry)", async () => {
        writeJsonl([
          { type: "user", message: { content: "implement auth" } },
          { type: "progress", status: "thinking" },
          { type: "progress", status: "writing" },
          { type: "assistant", message: { content: "I've implemented the auth feature." } },
        ]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("detects agent done with system summary", async () => {
        writeJsonl([
          { type: "user", message: { content: "fix tests" } },
          { type: "progress", status: "thinking" },
          { type: "assistant", message: { content: "Fixed!" } },
          { type: "system", summary: "Fixed failing tests" },
        ]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("detects stale finished session", async () => {
        writeJsonl(
          [
            { type: "user", message: { content: "implement auth" } },
            { type: "assistant", message: { content: "Done" } },
          ],
          600_000, // 10 min old
        );
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });
    });
  });
});
