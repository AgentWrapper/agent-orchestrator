/**
 * OpenCode activity plugin install + the plugin source itself.
 *
 * OpenCode auto-loads any `.js`/`.ts` file under `.opencode/plugins/` at
 * startup and invokes the exported factory with `{ directory, worktree, ... }`.
 * AO installs a plugin there that subscribes to OpenCode's event stream and
 * maps the relevant lifecycle events to AO activity states, replacing fragile
 * terminal-regex inference. `permission.asked` is the only authoritative source
 * of `waiting_input` OpenCode exposes.
 */
import { isWindows } from "@aoagents/ao-core";
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Filename of the auto-loaded OpenCode plugin AO installs per workspace. */
const OPENCODE_PLUGIN_FILENAME = "ao-activity.js";

/** Relative path used for the git-exclude entry that keeps the plugin out of PRs. */
const OPENCODE_PLUGIN_EXCLUDE_PATH = `.opencode/plugins/${OPENCODE_PLUGIN_FILENAME}`;

/**
 * Source of the OpenCode plugin that writes authoritative activity events to
 * `.ao/activity.jsonl` with `source: "hook"`.
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
 * `git rev-parse --git-path`), idempotently. Best-effort: keeping the plugin
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
 * Install the activity plugin into the workspace's `.opencode/plugins/` dir and
 * exclude it from git so it never appears in the agent's PRs.
 */
export async function installOpenCodeActivityPlugin(workspacePath: string): Promise<void> {
  const pluginDir = join(workspacePath, ".opencode", "plugins");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, OPENCODE_PLUGIN_FILENAME), OPENCODE_ACTIVITY_PLUGIN, "utf8");
  await addToGitExclude(workspacePath, OPENCODE_PLUGIN_EXCLUDE_PATH);
}
