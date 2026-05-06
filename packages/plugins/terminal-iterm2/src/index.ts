import { execFile } from "node:child_process";
import { platform } from "node:os";
import {
  escapeAppleScript,
  type PluginModule,
  type Terminal,
  type Session,
} from "@aoagents/ao-core";

export const manifest = {
  name: "iterm2",
  slot: "terminal" as const,
  description: "Terminal plugin: macOS iTerm2 tab management",
  version: "0.1.0",
};

// Re-export for backwards compatibility
export { escapeAppleScript } from "@aoagents/ao-core";

/**
 * Run an AppleScript snippet and return stdout.
 */
function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

/**
 * Escape a string for safe interpolation inside a shell single-quoted context.
 * Replaces ' with '\'' (end quote, escaped quote, start quote).
 */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Check if an iTerm2 tab already exists for this session by matching session name.
 * Returns true if found (and selects it), false otherwise.
 */
async function findAndSelectExistingTab(sessionName: string): Promise<boolean> {
  const safe = escapeAppleScript(sessionName);
  const script = `
tell application "iTerm2"
    repeat with aWindow in windows
        repeat with aTab in tabs of aWindow
            repeat with aSession in sessions of aTab
                try
                    if name of aSession is equal to "${safe}" then
                        select aWindow
                        select aTab
                        return "FOUND"
                    end if
                end try
            end repeat
        end repeat
    end repeat
    return "NOT_FOUND"
end tell`;

  const result = await runAppleScript(script);
  return result === "FOUND";
}

/**
 * Check if an iTerm2 tab exists for this session WITHOUT selecting it.
 * Pure query — no side effects on the UI.
 */
async function hasExistingTab(sessionName: string): Promise<boolean> {
  const safe = escapeAppleScript(sessionName);
  const script = `
tell application "iTerm2"
    repeat with aWindow in windows
        repeat with aTab in tabs of aWindow
            repeat with aSession in sessions of aTab
                try
                    if name of aSession is equal to "${safe}" then
                        return "FOUND"
                    end if
                end try
            end repeat
        end repeat
    end repeat
    return "NOT_FOUND"
end tell`;

  const result = await runAppleScript(script);
  return result === "FOUND";
}

/**
 * Open a new iTerm2 tab and attach to the given tmux session.
 * Creates a new window if no window is open.
 */
async function openNewTab(sessionName: string): Promise<void> {
  const safe = escapeAppleScript(sessionName);
  // Double-escape for the write text command: shell-escape first, then AppleScript-escape
  // the whole shell command so it's safe inside the AppleScript double-quoted string.
  const shellSafe = shellEscape(sessionName);
  const shellInAppleScript = escapeAppleScript(shellSafe);
  const script = `
tell application "iTerm2"
    activate
    if (count of windows) is 0 then
        create window with default profile
    else
        tell current window
            create tab with default profile
        end tell
    end if
    tell current session of current window
        set name to "${safe}"
        write text "printf '\\\\033]0;${shellInAppleScript}\\\\007' && tmux attach -t '${shellInAppleScript}'"
    end tell
end tell`;

  await runAppleScript(script);
}

function getSessionName(session: Session): string {
  // Use the runtime handle id if available (tmux session name), otherwise session id
  return session.runtimeHandle?.id ?? session.id;
}

function isMacOS(): boolean {
  return platform() === "darwin";
}

export function create(): Terminal {
  return {
    name: "iterm2",

    async openSession(session: Session): Promise<void> {
      if (!isMacOS()) {
        // eslint-disable-next-line no-console
        console.warn("[terminal-iterm2] iTerm2 is only available on macOS");
        return;
      }
      const sessionName = getSessionName(session);

      // Try to find and select an existing tab first
      const found = await findAndSelectExistingTab(sessionName);
      if (!found) {
        await openNewTab(sessionName);
      }
    },

    async openAll(sessions: Session[]): Promise<void> {
      if (!isMacOS() || sessions.length === 0) return;

      for (const session of sessions) {
        const sessionName = getSessionName(session);
        const found = await findAndSelectExistingTab(sessionName);
        if (!found) {
          await openNewTab(sessionName);
        }
        // Small delay between tab operations to avoid AppleScript race conditions
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    },

    async isSessionOpen(session: Session): Promise<boolean> {
      if (!isMacOS()) return false;
      const sessionName = getSessionName(session);
      try {
        // Query-only check — does NOT select/focus the tab
        return await hasExistingTab(sessionName);
      } catch {
        return false;
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Terminal>;
