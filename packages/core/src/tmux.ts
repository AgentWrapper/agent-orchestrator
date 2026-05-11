/**
 * tmux command wrappers — async helpers for tmux operations.
 *
 * Uses child_process.execFile for safe command execution (no shell injection).
 */

import { execFile } from "node:child_process";

/** Run a tmux command and return stdout. */
function tmux(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        // tmux exits non-zero for many benign cases (no sessions, etc.)
        reject(new Error(`tmux ${args[0]} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Check if tmux server is running. */
export async function isTmuxAvailable(): Promise<boolean> {
  try {
    await tmux("list-sessions", "-F", "#{session_name}");
    return true;
  } catch {
    return false;
  }
}

export interface TmuxSessionInfo {
  name: string;
  created: string;
  attached: boolean;
  windows: number;
}

/** List all tmux sessions. */
export async function listSessions(): Promise<TmuxSessionInfo[]> {
  try {
    const output = await tmux(
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_created_string}\t#{session_attached}\t#{session_windows}",
    );

    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name = "", created = "", attached = "0", windows = "1"] = line.split("\t");
        return {
          name,
          created,
          attached: attached !== "0",
          windows: parseInt(windows, 10) || 1,
        };
      });
  } catch {
    // No tmux server or no sessions
    return [];
  }
}

/** Check if a specific tmux session exists. */
export async function hasSession(sessionName: string): Promise<boolean> {
  try {
    await tmux("has-session", "-t", sessionName);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send keys (text + Enter) to a tmux session.
 * For long/multiline messages, uses load-buffer + paste-buffer with
 * a named buffer to avoid racing on the global paste buffer.
 * Sends Escape first to clear any partial input in the agent.
 */
export async function sendKeys(
  sessionName: string,
  text: string,
  pressEnter = true,
): Promise<void> {
  // Clear any partial input first (matches bash reference scripts)
  await tmux("send-keys", "-t", sessionName, "Escape");
  // Small delay to ensure Escape is processed before pasting
  await new Promise((resolve) => setTimeout(resolve, 100));

  if (text.includes("\n") || text.length > 200) {
    // Use a named buffer to avoid global paste buffer race conditions
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { randomUUID } = await import("node:crypto");

    const bufferName = `ao-${randomUUID().slice(0, 8)}`;
    const tmpFile = join(tmpdir(), `ao-tmux-${bufferName}.txt`);
    writeFileSync(tmpFile, text, { encoding: "utf-8", mode: 0o600 });

    try {
      await tmux("load-buffer", "-b", bufferName, tmpFile);
      await tmux("paste-buffer", "-b", bufferName, "-d", "-t", sessionName);
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        /* ignore cleanup errors */
      }
    }
  } else {
    // Use -l (literal) to prevent tmux from interpreting text as key names
    // (e.g. "Enter", "Escape", "C-c" would be treated as keypresses without -l)
    await tmux("send-keys", "-t", sessionName, "-l", text);
  }

  if (pressEnter) {
    // Delay for paste to complete before sending Enter
    // Higher delay needed when using paste-buffer to ensure tmux processes the paste
    // before receiving the Enter keystroke (especially with Claude permission prompts)
    if (text.includes("\n") || text.length > 200) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await tmux("send-keys", "-t", sessionName, "Enter");
  }
}

/**
 * Capture recent output from a tmux pane.
 *
 * @param sessionName - tmux session name
 * @param lines - Number of scrollback lines to capture (default 30)
 */
export async function capturePane(sessionName: string, lines = 30): Promise<string> {
  return tmux("capture-pane", "-t", sessionName, "-p", "-S", `-${lines}`);
}

/** Kill a tmux session. */
export async function killSession(sessionName: string): Promise<void> {
  await tmux("kill-session", "-t", sessionName);
}

/**
 * Get the TTY device for a tmux session's first pane.
 * Useful for finding processes running in the session.
 */
export async function getPaneTTY(sessionName: string): Promise<string | null> {
  try {
    const output = await tmux("list-panes", "-t", sessionName, "-F", "#{pane_tty}");
    const tty = output.trim().split("\n")[0];
    return tty || null;
  } catch {
    return null;
  }
}
