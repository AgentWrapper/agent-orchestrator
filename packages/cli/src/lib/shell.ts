import { type ChildProcess, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { killProcessTree } from "@aoagents/ao-core";

const execFileAsync = promisify(execFileCb);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export async function exec(
  cmd: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> },
): Promise<ExecResult> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd: options?.cwd,
    env: options?.env ? { ...process.env, ...options.env } : undefined,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
}

export async function execSilent(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args);
    return stdout;
  } catch {
    return null;
  }
}

export async function tmux(...args: string[]): Promise<string | null> {
  return execSilent("tmux", args);
}

export async function git(args: string[], cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", args, { cwd });
    return stdout;
  } catch {
    return null;
  }
}

export async function gh(args: string[]): Promise<string | null> {
  return execSilent("gh", args);
}

export async function getTmuxSessions(): Promise<string[]> {
  const output = await tmux("list-sessions", "-F", "#{session_name}");
  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

/**
 * Forward SIGINT/SIGTERM from the parent to a detached child's process group.
 * Required on Unix when a child is spawned with detached:true — Ctrl+C only
 * reaches the parent's process group, not the child's.
 *
 * Sends SIGTERM immediately, then escalates to SIGKILL after 5 s if the child
 * has not exited — prevents the parent from hanging indefinitely with no signal
 * handlers registered. Cleans up automatically when the child exits normally.
 *
 * Idempotent: calling with the same child object more than once is a no-op.
 */
const _signalForwardedChildren = new WeakSet<ChildProcess>();

export function forwardSignalsToChild(pid: number, child: ChildProcess): void {
  if (_signalForwardedChildren.has(child)) return;
  _signalForwardedChildren.add(child);
  let fallback: ReturnType<typeof setTimeout> | undefined;

  const forward = (): void => {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
    void killProcessTree(pid, "SIGTERM");
    // If the child ignores SIGTERM, force-kill after 5 s so the parent exits.
    // Exit 0: this path is reached on user-initiated Ctrl+C where the child is
    // merely slow to drain (e.g. Next.js connections). Treating that as an
    // error breaks shell scripts and CI pipelines that check the exit code.
    fallback = setTimeout(() => {
      void killProcessTree(pid, "SIGKILL").finally(() => process.exit(0));
    }, 5000);
    fallback.unref();
  };
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);
  child.once("exit", () => {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
    if (fallback !== undefined) clearTimeout(fallback);
  });
}

export async function getTmuxActivity(session: string): Promise<number | null> {
  const output = await tmux("display-message", "-t", session, "-p", "#{session_activity}");
  if (!output) return null;
  const ts = parseInt(output, 10);
  return isNaN(ts) ? null : ts * 1000;
}
