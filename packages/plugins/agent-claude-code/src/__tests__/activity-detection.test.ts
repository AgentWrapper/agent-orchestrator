import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toClaudeProjectPath, create } from "../index.js";
import { createActivitySignal, type Session, type RuntimeHandle } from "@aoagents/ao-core";

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
    workspacePath,
    runtimeHandle: handle,
    agentInfo: null,
    createdAt: new Date(),
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
      expect(toClaudeProjectPath("C:\\Users\\dev\\project")).toBe("C-Users-dev-project");
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
      fakeHome = mkdtempSync(join(tmpdir(), "ao-activity-test-"));
      workspacePath = join(fakeHome, "workspace");
      mkdirSync(workspacePath, { recursive: true });

      // Create the Claude project directory matching the workspace path
      const encoded = toClaudeProjectPath(workspacePath);
      projectDir = join(fakeHome, ".claude", "projects", encoded);
      mkdirSync(projectDir, { recursive: true });

      // Mock isProcessRunning to always return true (we test exited separately)
      vi.spyOn(agent, "isProcessRunning").mockResolvedValue(true);
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

    it("returns 'idle' when no session file exists yet", async () => {
      // projectDir exists but is empty — no .jsonl files yet (freshly spawned session)
      const session = makeSession();
      const result = await agent.getActivityState(session);
      expect(result?.state).toBe("idle");
      // timestamp must be session.createdAt so stuck-detection can fire eventually
      expect(result?.timestamp).toBe(session.createdAt);
    });

    it("returns null when no workspacePath", async () => {
      expect(await agent.getActivityState(makeSession({ workspacePath: null }))).toBeNull();
    });

    it("returns 'idle' when project directory does not exist", async () => {
      // Process is running but no Claude project dir yet — treat as idle
      const badPath = join(fakeHome, "nonexistent-workspace");
      expect((await agent.getActivityState(makeSession({ workspacePath: badPath })))?.state).toBe("idle");
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

      it("returns 'active' for recent 'file-history-snapshot' (bookkeeping)", async () => {
        writeJsonl([{ type: "file-history-snapshot" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });

      it("returns 'active' for recent 'queue-operation' (bookkeeping)", async () => {
        writeJsonl([{ type: "queue-operation" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });

      it("returns 'active' for recent 'pr-link' (bookkeeping)", async () => {
        writeJsonl([{ type: "pr-link" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });
    });

    // -----------------------------------------------------------------------
    // Agent interface spec types (may appear in future versions)
    // -----------------------------------------------------------------------

    describe("agent interface spec types", () => {
      it("returns 'active' for recent 'tool_use' entry", async () => {
        writeJsonl([{ type: "tool_use" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });

      it("returns 'waiting_input' for 'permission_request'", async () => {
        writeJsonl([{ type: "permission_request" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("waiting_input");
      });

      it("returns 'blocked' for 'error'", async () => {
        writeJsonl([{ type: "error" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("blocked");
      });

      it("returns 'ready' for recent 'summary' entry", async () => {
        writeJsonl([{ type: "summary", summary: "Implemented login feature" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("returns 'ready' for recent 'result' entry", async () => {
        writeJsonl([{ type: "result" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
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

      it("'permission_request' ignores staleness (always waiting_input)", async () => {
        writeJsonl([{ type: "permission_request" }], 400_000);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("waiting_input");
      });

      it("'error' ignores staleness (always blocked)", async () => {
        writeJsonl([{ type: "error" }], 400_000);
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
        // No real session file → process is running, treat as idle
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
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
