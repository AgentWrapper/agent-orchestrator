import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isWindows } from "@aoagents/ao-core";
import { ACTIVITY_UPDATER_SCRIPT, ACTIVITY_UPDATER_SCRIPT_NODE } from "./index.js";

// ---------------------------------------------------------------------------
// Integration tests for the activity-updater hook script (#1941).
// Pipes synthetic Claude Code hook JSON payloads into the real script and
// asserts the JSONL line written to {workspace}/.ao/activity.jsonl matches.
//
// Both the bash variant (Unix) and the Node variant (Windows) are exercised
// against the same scenario table to keep them in lockstep.
// ---------------------------------------------------------------------------

let scratchDir: string;
let bashScript: string;
let nodeScript: string;

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "ao-activity-hook-"));
  bashScript = join(scratchDir, "activity-updater.sh");
  nodeScript = join(scratchDir, "activity-updater.cjs");
  writeFileSync(bashScript, ACTIVITY_UPDATER_SCRIPT, { mode: 0o755 });
  writeFileSync(nodeScript, ACTIVITY_UPDATER_SCRIPT_NODE, "utf-8");
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

interface HookInput {
  hook_event_name: string;
  // Common-payload fields are optional in this synthetic shape; runtime payloads always have them.
  session_id?: string;
  cwd?: string;
  notification_type?: string;
  tool_name?: string;
  error_type?: string;
  error_message?: string;
}

interface HookResult {
  stdout: string;
  lastEntry: Record<string, unknown> | null;
  rawJsonl: string;
}

type Variant = "bash" | "node";

function runHook(variant: Variant, payload: HookInput): HookResult {
  const workspace = mkdtempSync(join(scratchDir, "ws-"));
  const input = JSON.stringify(payload);
  let stdout: string;
  try {
    const cmd = variant === "bash" ? `bash "${bashScript}"` : `node "${nodeScript}"`;
    stdout = execSync(cmd, {
      input,
      env: { ...process.env, CLAUDE_PROJECT_DIR: workspace },
      encoding: "utf-8",
      timeout: 5000,
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    stdout = e.stdout ?? "";
  }

  const logFile = join(workspace, ".ao", "activity.jsonl");
  let rawJsonl = "";
  let lastEntry: Record<string, unknown> | null = null;
  if (existsSync(logFile)) {
    rawJsonl = readFileSync(logFile, "utf-8");
    const lines = rawJsonl.split("\n").filter((l) => l.trim());
    if (lines.length > 0) {
      try {
        lastEntry = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
      } catch {
        lastEntry = null;
      }
    }
  }
  return { stdout, lastEntry, rawJsonl };
}

// Each scenario is executed against both the bash and the Node variant so
// drift between the two implementations is caught immediately. The bash
// suite is skipped on Windows — bash isn't a native shell there, so
// `execSync('bash "..."')` would throw ENOENT for every case. The Node
// variant is the Windows-supported path (and is exercised on Unix too,
// guarding against drift). Matches the `describe.skipIf` pattern used by
// `packages/core/src/__tests__/migration-storage-v2.test.ts`.
const variants: Variant[] = ["bash", "node"];

for (const variant of variants) {
  describe.skipIf(variant === "bash" && isWindows())(`activity-updater (${variant})`, () => {
    // -----------------------------------------------------------------------
    // active states — turn-in-progress markers
    // -----------------------------------------------------------------------
    it.each([
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PreCompact",
      "PostCompact",
      "SubagentStart",
      "PostToolBatch",
    ])("writes active for %s", (event) => {
      const { lastEntry } = runHook(variant, { hook_event_name: event });
      expect(lastEntry).not.toBeNull();
      expect(lastEntry!.state).toBe("active");
      expect(lastEntry!.source).toBe("hook");
      expect(lastEntry).not.toHaveProperty("trigger");
    });

    // -----------------------------------------------------------------------
    // ready states — turn boundaries
    // -----------------------------------------------------------------------
    it.each(["SessionStart", "Stop", "SubagentStop"])("writes ready for %s", (event) => {
      const { lastEntry } = runHook(variant, { hook_event_name: event });
      expect(lastEntry!.state).toBe("ready");
      expect(lastEntry!.source).toBe("hook");
    });

    // -----------------------------------------------------------------------
    // waiting_input — PermissionRequest is the authoritative signal
    // -----------------------------------------------------------------------
    it("writes waiting_input for PermissionRequest with tool_name in trigger", () => {
      const { lastEntry } = runHook(variant, {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
      });
      expect(lastEntry!.state).toBe("waiting_input");
      expect(lastEntry!.source).toBe("hook");
      expect(lastEntry!.trigger).toBe("PermissionRequest (Bash)");
    });

    it("writes waiting_input for PermissionRequest without tool_name", () => {
      const { lastEntry } = runHook(variant, { hook_event_name: "PermissionRequest" });
      expect(lastEntry!.state).toBe("waiting_input");
      expect(lastEntry!.trigger).toBe("PermissionRequest");
    });

    // -----------------------------------------------------------------------
    // Notification — MUST filter by notification_type so auth_success /
    // elicitation_* don't false-fire waiting_input.
    // -----------------------------------------------------------------------
    it("writes waiting_input for Notification(permission_prompt)", () => {
      const { lastEntry } = runHook(variant, {
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
      });
      expect(lastEntry!.state).toBe("waiting_input");
      expect(lastEntry!.trigger).toBe("Notification (permission_prompt)");
    });

    it("writes waiting_input for Notification(idle_prompt)", () => {
      const { lastEntry } = runHook(variant, {
        hook_event_name: "Notification",
        notification_type: "idle_prompt",
      });
      expect(lastEntry!.state).toBe("waiting_input");
      expect(lastEntry!.trigger).toBe("Notification (idle_prompt)");
    });

    it("skips Notification(auth_success) — not a stuck-on-the-user state", () => {
      const { lastEntry, stdout } = runHook(variant, {
        hook_event_name: "Notification",
        notification_type: "auth_success",
      });
      expect(lastEntry).toBeNull();
      expect(stdout.trim()).toBe("{}");
    });

    it("skips Notification(elicitation_response)", () => {
      const { lastEntry } = runHook(variant, {
        hook_event_name: "Notification",
        notification_type: "elicitation_response",
      });
      expect(lastEntry).toBeNull();
    });

    // -----------------------------------------------------------------------
    // blocked — StopFailure is the authoritative API-error signal
    // -----------------------------------------------------------------------
    it("writes blocked for StopFailure with error_type in trigger", () => {
      const { lastEntry } = runHook(variant, {
        hook_event_name: "StopFailure",
        error_type: "rate_limit",
        error_message: "Rate limited",
      });
      expect(lastEntry!.state).toBe("blocked");
      expect(lastEntry!.source).toBe("hook");
      expect(lastEntry!.trigger).toBe("StopFailure (rate_limit)");
    });

    it("writes blocked for StopFailure without error_type", () => {
      const { lastEntry } = runHook(variant, { hook_event_name: "StopFailure" });
      expect(lastEntry!.state).toBe("blocked");
      expect(lastEntry!.trigger).toBe("StopFailure");
    });

    // -----------------------------------------------------------------------
    // No-ops — unknown event names + ignored events
    // -----------------------------------------------------------------------
    it.each(["SessionEnd", "TaskCreated", "FileChanged", "UnknownFutureEvent"])(
      "ignores unhandled event %s",
      (event) => {
        const { lastEntry, stdout } = runHook(variant, { hook_event_name: event });
        expect(lastEntry).toBeNull();
        expect(stdout.trim()).toBe("{}");
      },
    );

    it("returns {} stdout so Claude doesn't surface a hook decision", () => {
      const { stdout } = runHook(variant, { hook_event_name: "Stop" });
      expect(stdout.trim()).toBe("{}");
    });

    it("creates .ao/ directory on first write", () => {
      const { rawJsonl } = runHook(variant, { hook_event_name: "Stop" });
      expect(rawJsonl.length).toBeGreaterThan(0);
    });

    it("emits a parseable JSON line with a valid ISO timestamp", () => {
      const { lastEntry } = runHook(variant, { hook_event_name: "Stop" });
      expect(lastEntry).not.toBeNull();
      const ts = lastEntry!.ts as string;
      expect(typeof ts).toBe("string");
      // ISO 8601 with millisecond precision and Z suffix
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
    });

    it("escapes control chars in trigger so the JSONL line stays parseable", () => {
      // Bounded by Claude's enums today (`error_type`, `tool_name` never contain
      // \n/\r/\t), but if a future hook payload field flows into `trigger`
      // unescaped, a literal newline would split one entry into two and break
      // the JSONL parser. This locks in JSON-style escaping across both
      // bash and Node variants.
      const { lastEntry, rawJsonl } = runHook(variant, {
        hook_event_name: "StopFailure",
        // Smuggle a multi-line value through error_type — covers \n/\t/\r/\\/".
        error_type: 'multi\nline\twith\rmixed\\\\and"quotes',
      });
      // Exactly one JSONL line (control chars escaped, not literal)
      expect(rawJsonl.split("\n").filter((l) => l.trim())).toHaveLength(1);
      // Parsed entry round-trips the original string
      expect(lastEntry!.state).toBe("blocked");
      expect(lastEntry!.trigger).toBe('StopFailure (multi\nline\twith\rmixed\\\\and"quotes)');
    });
  });
}
