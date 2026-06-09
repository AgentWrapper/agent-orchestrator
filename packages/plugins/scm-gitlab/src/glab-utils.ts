/**
 * Shared helpers for GitLab plugins that use the `glab` CLI.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function glab(args: string[], hostname?: string): Promise<string> {
  // glab resolves self-hosted instances via GITLAB_HOST; most subcommands do
  // not accept a per-command --hostname flag.
  const env = hostname ? { ...process.env, GITLAB_HOST: hostname } : process.env;

  try {
    const { stdout } = await execFileAsync("glab", args, {
      env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`glab ${args.slice(0, 3).join(" ")} failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

export function parseJSON<T>(raw: string, context: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${context}: expected JSON but got: ${raw.slice(0, 200)}`, { cause: err });
  }
}

export function extractHost(repo: string): string | undefined {
  const parts = repo.split("/");
  const first = parts[0];
  return first && first.includes(".") && parts.length >= 3 ? first : undefined;
}

export function stripHost(fullPath: string): string {
  const parts = fullPath.split("/");
  if (parts[0] && parts[0].includes(".") && parts.length >= 3) {
    return parts.slice(1).join("/");
  }
  return fullPath;
}
