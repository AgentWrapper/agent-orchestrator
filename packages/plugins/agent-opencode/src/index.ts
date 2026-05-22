import {
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  shellEscape,
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  asValidOpenCodeSessionId,
  isWindows,
  PROCESS_PROBE_INDETERMINATE,
  getCachedOpenCodeSessionList,
  getOpenCodeChildEnv,
  ensureOpenCodeTmpDir,
  resetOpenCodeSessionListCache,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type ProcessProbeResult,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
  type OpenCodeAgentConfig,
  type OpenCodeSessionListEntry,
} from "@aoagents/ao-core";
import { execFile, execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function parseUpdatedTimestamp(updated: string | number | undefined): Date | null {
  if (typeof updated === "number") {
    if (!Number.isFinite(updated)) return null;
    const date = new Date(updated);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof updated !== "string") return null;

  const trimmed = updated.trim();
  if (trimmed.length === 0) return null;

  if (/^\d+$/.test(trimmed)) {
    const epochMs = Number(trimmed);
    if (!Number.isFinite(epochMs)) return null;
    const date = new Date(epochMs);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsedMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedMs)) return null;
  return new Date(parsedMs);
}

// Re-export for backward compat — see @aoagents/ao-core/opencode-shared.
export { resetOpenCodeSessionListCache };

/**
 * Parse JSON stream lines from `opencode run --format json` output.
 * Each line is a JSON object. We look for objects containing a session_id field.
 * The step_start event typically contains the session_id.
 */
function buildSessionIdCaptureScript(): string {
  const script = `
let buffer = '';
let captured = null;
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (captured) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      const sid = (typeof obj.session_id === 'string' && obj.session_id) || (typeof obj.sessionID === 'string' && obj.sessionID);
      if (sid && /^ses_[A-Za-z0-9_-]+$/.test(sid)) {
        captured = sid;
      }
    } catch {}
  }
}).on('end', () => {
  if (buffer.trim()) {
    try {
      const obj = JSON.parse(buffer.trim());
      const sid = (typeof obj.session_id === 'string' && obj.session_id) || (typeof obj.sessionID === 'string' && obj.sessionID);
      if (sid && /^ses_[A-Za-z0-9_-]+$/.test(sid)) {
        captured = sid;
      }
    } catch {}
  }
  if (captured) {
    process.stdout.write(captured);
    process.exit(0);
  }
  process.exit(1);
});
  `.trim();
  return script.replace(/\n/g, " ").replace(/\s+/g, " ");
}

function buildSessionLookupScript(): string {
  const script = `
let input = '';
process.stdin.on('data', c => input += c).on('end', () => {
  const title = process.argv[1];
  let rows;
  try { rows = JSON.parse(input); } catch { process.exit(1); }
  if (!Array.isArray(rows)) process.exit(1);
  const isValidId = id => /^ses_[A-Za-z0-9_-]+$/.test(id);
  const timestamp = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    }
    return Number.NEGATIVE_INFINITY;
  };
  const matches = rows
    .filter(r => r && r.title === title && typeof r.id === 'string' && isValidId(r.id))
    .sort((a, b) => {
      const ta = timestamp(a.updated);
      const tb = timestamp(b.updated);
      if (ta === tb) return 0;
      return tb - ta;
    });
  if (matches.length === 0) process.exit(1);
  process.stdout.write(matches[0].id);
});
  `.trim();
  return script.replace(/\n/g, " ").replace(/\s+/g, " ");
}

// =============================================================================
// Session List Helpers
// =============================================================================

/**
 * Query OpenCode's session list and find the matching session for this AO session.
 * Tries metadata `opencodeSessionId` first, then falls back to title matching.
 */
async function findOpenCodeSession(
  session: Session,
): Promise<OpenCodeSessionListEntry | null> {
  try {
    const sessions = await getCachedOpenCodeSessionList();

    // Prefer exact ID match from metadata
    if (session.metadata?.opencodeSessionId) {
      const match = sessions.find((s) => s.id === session.metadata.opencodeSessionId);
      if (match) return match;
    }

    // Fallback: title match — pick the most recently updated session
    // to avoid binding to a stale session when titles collide.
    const titleMatches = sessions.filter((s) => s.title === `AO:${session.id}`);
    if (titleMatches.length === 0) return null;
    if (titleMatches.length === 1) return titleMatches[0]!;
    return titleMatches.reduce((best, s) => {
      const bestTs = parseUpdatedTimestamp(best.updated)?.getTime() ?? 0;
      const sTs = parseUpdatedTimestamp(s.updated)?.getTime() ?? 0;
      return sTs > bestTs ? s : best;
    });
  } catch {
    return null;
  }
}

// =============================================================================
// Activity Plugin (installed into the workspace's .opencode/plugins/)
// =============================================================================

/** Filename of the auto-loaded OpenCode plugin AO installs per workspace. */
const OPENCODE_PLUGIN_FILENAME = "ao-activity.js";

/** Relative path used for the git-exclude entry that keeps the plugin out of PRs. */
const OPENCODE_PLUGIN_EXCLUDE_PATH = `.opencode/plugins/${OPENCODE_PLUGIN_FILENAME}`;

/**
 * Source of the OpenCode plugin that writes authoritative activity events to
 * `.ao/activity.jsonl` with `source: "hook"`.
 *
 * OpenCode auto-loads any `.js`/`.ts` file under `.opencode/plugins/` at
 * startup and invokes the exported factory with `{ directory, worktree, ... }`.
 * The plugin subscribes to OpenCode's event stream and maps the relevant
 * lifecycle events to AO activity states. This replaces fragile terminal-regex
 * inference — `permission.asked` is the only authoritative source of
 * `waiting_input` OpenCode exposes.
 *
 * Guards mirror the Codex hook updater: it no-ops unless `AO_SESSION_ID` is set
 * (so a human running `opencode` in the same worktree never writes AO entries)
 * and honors `AO_OPENCODE_HOOK_ACTIVITY=0` as an opt-out. `idle` is never
 * written — AO's age-decay derives idle from a stale `ready`/`active` entry.
 */
export const OPENCODE_ACTIVITY_PLUGIN = `// Agent Orchestrator activity plugin — auto-generated. Do not edit.
import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

export const AoActivity = async ({ directory, worktree }) => {
  const sessionId = process.env.AO_SESSION_ID;
  if (!sessionId || process.env.AO_OPENCODE_HOOK_ACTIVITY === "0") return {};

  const base = directory || worktree || process.cwd();
  const logPath = join(base, ".ao", "activity.jsonl");

  let lastActiveWrite = 0;

  const write = async (state, trigger) => {
    try {
      await mkdir(dirname(logPath), { recursive: true });
      const entry = { ts: new Date().toISOString(), state, source: "hook", sessionId };
      if (trigger && (state === "waiting_input" || state === "blocked")) {
        entry.trigger = trigger;
      }
      await appendFile(logPath, JSON.stringify(entry) + "\\n", "utf8");
    } catch {
      // Best-effort: activity logging must never break the agent.
    }
  };

  return {
    event: async ({ event }) => {
      const type = event && event.type;
      switch (type) {
        case "permission.asked":
          return write("waiting_input", "permission.asked");
        case "session.error":
          return write("blocked", "session.error");
        case "session.idle":
          return write("ready", "session.idle");
        case "tool.execute.before":
        case "tool.execute.after":
        case "file.edited":
        case "message.updated":
        case "message.part.updated": {
          // Coalesce high-frequency streaming events to bound JSONL growth.
          const now = Date.now();
          if (now - lastActiveWrite < 5000) return;
          lastActiveWrite = now;
          return write("active");
        }
        default:
          return;
      }
    },
  };
};
`;

/**
 * Append a pattern to the workspace's git exclude file (worktree-aware via
 * \`git rev-parse --git-path\`), idempotently. Best-effort: keeping the plugin
 * out of the agent's PRs is a nicety, not a correctness requirement.
 */
async function addToGitExclude(workspacePath: string, pattern: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspacePath, "rev-parse", "--git-path", "info/exclude"],
      {
        timeout: 10_000,
        ...(isWindows() ? { shell: true, windowsHide: true } : {}),
      },
    );
    const rel = stdout.trim();
    if (!rel) return;
    const excludePath = isAbsolute(rel) ? rel : join(workspacePath, rel);

    let existing = "";
    try {
      existing = await readFile(excludePath, "utf8");
    } catch {
      // No exclude file yet — we'll create it below.
    }
    if (existing.split("\n").some((line) => line.trim() === pattern)) return;

    await mkdir(dirname(excludePath), { recursive: true });
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await appendFile(excludePath, `${prefix}${pattern}\n`, "utf8");
  } catch {
    // Best-effort only.
  }
}

/**
 * Install the activity plugin into the workspace's \`.opencode/plugins/\` dir and
 * exclude it from git so it never appears in the agent's PRs.
 */
async function installOpenCodeActivityPlugin(workspacePath: string): Promise<void> {
  const pluginDir = join(workspacePath, ".opencode", "plugins");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, OPENCODE_PLUGIN_FILENAME), OPENCODE_ACTIVITY_PLUGIN, "utf8");
  await addToGitExclude(workspacePath, OPENCODE_PLUGIN_EXCLUDE_PATH);
}

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "opencode",
  slot: "agent" as const,
  description: "Agent plugin: OpenCode",
  version: "0.1.0",
  displayName: "OpenCode",
};

// =============================================================================
// Agent Implementation
// =============================================================================

function createOpenCodeAgent(): Agent {
  return {
    name: "opencode",
    processName: "opencode",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const options: string[] = [];
      const sharedOptions: string[] = [];
      const agentConfig = config.projectConfig.agentConfig;

      const existingSessionId = asValidOpenCodeSessionId(
        agentConfig?.opencodeSessionId,
      );

      if (existingSessionId) {
        options.push("--session", shellEscape(existingSessionId));
      }

      const selectedAgentName = config.subagent;

      if (selectedAgentName) {
        sharedOptions.push("--agent", shellEscape(selectedAgentName));
      }

      const promptValue = config.prompt ? shellEscape(config.prompt) : undefined;

      if (config.model) {
        sharedOptions.push("--model", shellEscape(config.model));
      }

      if (!existingSessionId) {
        const runOptions = [
          "--format",
          "json",
          "--title",
          shellEscape(`AO:${config.sessionId}`),
          ...sharedOptions,
        ];
        const captureScript = buildSessionIdCaptureScript();
        const fallbackScript = buildSessionLookupScript();
        const runCommand = ["opencode", "run", ...runOptions, "--command", "true"].join(" ");
        const resumeOptions = [...(promptValue ? ["--prompt", promptValue] : []), ...sharedOptions];
        const resumeOptionsSuffix = resumeOptions.length > 0 ? ` ${resumeOptions.join(" ")}` : "";
        const missingSessionError = shellEscape(
          `failed to discover OpenCode session ID for AO:${config.sessionId}`,
        );
        return [
          `SES_ID=$(${runCommand} | node -e ${shellEscape(captureScript)})`,
          `if [ -z "$SES_ID" ]; then SES_ID=$(opencode session list --format json | node -e ${shellEscape(fallbackScript)} ${shellEscape(`AO:${config.sessionId}`)}); fi`,
          `[ -n "$SES_ID" ] && exec opencode --session "$SES_ID"${resumeOptionsSuffix}; echo ${missingSessionError} >&2; exit 1`,
        ].join("; ");
      }

      if (promptValue) {
        options.push("--prompt", promptValue);
      }

      options.push(...sharedOptions);

      return ["opencode", ...options].join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      // NOTE: AO_PROJECT_ID is the caller's responsibility (spawn.ts sets it)
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      // Point Bun's embedded shared-library extraction at an AO-owned temp
      // dir so the cli-side janitor only needs to sweep our own files
      // (issue #1046). Setting all three keys covers POSIX (TMPDIR) and
      // Windows fallbacks; opencode itself ships POSIX-only today.
      const tmpDir = ensureOpenCodeTmpDir();
      env["TMPDIR"] = tmpDir;
      env["TMP"] = tmpDir;
      env["TEMP"] = tmpDir;

      // PATH and GH_PATH are injected by session-manager for all agents.

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";

      const lines = terminalOutput.trim().split("\n");
      const lastLine = lines[lines.length - 1]?.trim() ?? "";

      // OpenCode's input prompt — agent is idle
      if (/^[>$#]\s*$/.test(lastLine)) return "idle";

      // Check the last few lines for permission/confirmation prompts
      const tail = lines.slice(-5).join("\n");
      if (/\(Y\)es.*\(N\)o/i.test(tail)) return "waiting_input";
      if (/approval required/i.test(tail)) return "waiting_input";
      if (/Do you want to proceed\?/i.test(tail)) return "waiting_input";
      if (/Allow .+\?/i.test(tail)) return "waiting_input";

      return "active";
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;
      const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);

      // Check if process is running first
      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (running === PROCESS_PROBE_INDETERMINATE) return null;
      if (!running) return { state: "exited", timestamp: exitedAt };

      // 1. Check AO activity JSONL first (written by recordActivity from terminal output).
      //    This is the only source of waiting_input/blocked states for OpenCode.
      let activityResult: Awaited<ReturnType<typeof readLastActivityEntry>> = null;
      if (session.workspacePath) {
        activityResult = await readLastActivityEntry(session.workspacePath);
        const activityState = checkActivityLogState(activityResult);
        if (activityState) return activityState;
      }

      // 1b. Hook entries are authoritative real-time platform events, so they
      //     win over the polled session-list API for active/ready/idle too.
      //     (waiting_input/blocked already returned above via checkActivityLogState.)
      //     Terminal-source entries deliberately do NOT short-circuit here —
      //     only the event-driven plugin produces trustworthy timing.
      if (activityResult?.entry.source === "hook") {
        const hookState = getActivityFallbackState(activityResult, activeWindowMs, threshold);
        if (hookState) return hookState;
      }

      // 2. Fallback: query OpenCode's session list API for timestamp-based detection
      const targetSession = await findOpenCodeSession(session);
      if (targetSession) {
        const lastActivity = parseUpdatedTimestamp(targetSession.updated);

        if (lastActivity) {
          const ageMs = Math.max(0, Date.now() - lastActivity.getTime());
          if (ageMs <= activeWindowMs) {
            return { state: "active", timestamp: lastActivity };
          }
          if (ageMs <= threshold) {
            return { state: "ready", timestamp: lastActivity };
          }
          return { state: "idle", timestamp: lastActivity };
        }
      }

      // 3. Fallback: use JSONL entry with age-based decay when session list is unavailable.
      const fallback = getActivityFallbackState(activityResult, activeWindowMs, threshold);
      if (fallback) return fallback;

      return null;
    },

    // recordActivity is intentionally NOT implemented. The activity plugin
    // installed by setupWorkspaceHooks writes authoritative hook events to
    // .ao/activity.jsonl directly; polling-driven terminal classification would
    // only add stale duplicates that shadow those events (mirrors Claude #1941).

    async isProcessRunning(handle: RuntimeHandle): Promise<ProcessProbeResult> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
          // tmux and ps are Unix-only; guard before any tmux calls on Windows.
          if (isWindows()) return false;
          const { stdout: ttyOut } = await execFileAsync(
            "tmux",
            ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
            { timeout: 30_000 },
          );
          const ttys = ttyOut
            .trim()
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean);
          if (ttys.length === 0) return false;

          const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
            timeout: 30_000,
          });
          if (!psOut) return PROCESS_PROBE_INDETERMINATE;
          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)opencode(?:\s|$)/;
          for (const line of psOut.split("\n")) {
            const cols = line.trimStart().split(/\s+/);
            if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
            const args = cols.slice(2).join(" ");
            if (processRe.test(args)) {
              return true;
            }
          }
          return false;
        }

        const rawPid = handle.data["pid"];
        const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            return true;
          } catch (err: unknown) {
            if (err instanceof Error && "code" in err && err.code === "EPERM") {
              return true;
            }
            return false;
          }
        }

        return false;
      } catch {
        return PROCESS_PROBE_INDETERMINATE;
      }
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      const targetSession = await findOpenCodeSession(session);
      if (!targetSession) return null;

      return {
        summary: targetSession.title ?? null,
        summaryIsFallback: true,
        agentSessionId: targetSession.id,
        // OpenCode doesn't expose token/cost data in session list
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      // Try metadata first, then query OpenCode's session list
      const sessionId =
        asValidOpenCodeSessionId(session.metadata?.opencodeSessionId) ??
        (await findOpenCodeSession(session))?.id ??
        null;

      if (!sessionId) return null;

      const parts: string[] = ["opencode", "--session", shellEscape(sessionId)];

      const agentConfig = project.agentConfig as OpenCodeAgentConfig | undefined;
      if (agentConfig?.model) {
        parts.push("--model", shellEscape(agentConfig.model as string));
      }

      return parts.join(" ");
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      // PATH wrappers are installed by session-manager for all agents.
      // Install the activity plugin so OpenCode emits authoritative activity
      // events to .ao/activity.jsonl (replaces terminal-regex inference).
      await installOpenCodeActivityPlugin(workspacePath);
    },

    async postLaunchSetup(_session: Session): Promise<void> {
      // PATH wrappers are re-ensured by session-manager.
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createOpenCodeAgent();
}

export function detect(): boolean {
  try {
    execFileSync("opencode", ["version"], {
      stdio: "ignore",
      // On Windows, execFileSync cannot resolve .cmd shim extensions without
      // invoking the shell; windowsHide:true suppresses the conhost popup.
      shell: isWindows(),
      windowsHide: true,
      env: getOpenCodeChildEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
