import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
  type AttachInfo,
  type PluginModule,
  type Runtime,
  type RuntimeCreateConfig,
  type RuntimeHandle,
  type RuntimeMetrics,
  shellEscape,
} from "@aoagents/ao-core";

const execFileAsync = promisify(execFile);
const ZELLIJ_COMMAND_TIMEOUT_MS = 5_000;
const ZELLIJ_SESSION_NAME_MAX_LENGTH = 25;

export const manifest = {
  name: "zellij",
  slot: "runtime" as const,
  description: "Runtime plugin: Zellij sessions",
  version: "0.1.0",
};

const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;
const SAFE_ENV_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

function envExportLines(environment: Record<string, string>): string {
  return Object.entries(environment)
    .map(([key, value]) => {
      if (!SAFE_ENV_NAME.test(key)) {
        throw new Error(`Invalid environment variable name "${key}"`);
      }
      return `export ${key}=${shellEscape(value)}`;
    })
    .join("\n");
}

function toZellijSessionName(sessionId: string): string {
  if (sessionId.length <= ZELLIJ_SESSION_NAME_MAX_LENGTH) {
    return sessionId;
  }

  const prefix = sessionId.slice(0, 8);
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  return `ao-${prefix}-${hash}`;
}

function getZellijSessionName(handle: RuntimeHandle): string {
  return String(handle.data.zellijSessionName ?? handle.id);
}

function writeLaunchScript(command: string, environment: Record<string, string>): string {
  const scriptPath = join(tmpdir(), `ao-zellij-launch-${randomUUID()}.sh`);
  const exports = envExportLines(environment);
  const content = ["#!/usr/bin/env bash", 'rm -- "$0" 2>/dev/null || true', exports, command, ""]
    .filter(Boolean)
    .join("\n");
  writeFileSync(scriptPath, content, { encoding: "utf-8", mode: 0o700 });
  return scriptPath;
}

async function zellij(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("zellij", args, {
    timeout: ZELLIJ_COMMAND_TIMEOUT_MS,
  });
  return stdout.trimEnd();
}

function parsePaneId(stdout: string): string {
  const paneId = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^terminal_\d+$/.test(line));

  if (!paneId) {
    throw new Error(`Could not parse Zellij pane id from output: ${JSON.stringify(stdout)}`);
  }

  return paneId;
}

async function sessionExists(sessionName: string): Promise<boolean> {
  try {
    const stdout = await zellij("list-sessions", "--short", "--no-formatting");
    return stdout.split(/\r?\n/).some((line) => line.trim() === sessionName);
  } catch {
    return false;
  }
}

export function create(): Runtime {
  return {
    name: "zellij",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(config.sessionId);
      const sessionName = toZellijSessionName(config.sessionId);

      if (await sessionExists(sessionName)) {
        throw new Error(`Session "${sessionName}" already exists — destroy it before re-creating`);
      }

      await zellij("attach", "--create-background", sessionName);

      try {
        const scriptPath = writeLaunchScript(config.launchCommand, config.environment ?? {});
        const paneStdout = await zellij(
          "--session",
          sessionName,
          "run",
          "--name",
          sessionName,
          "--cwd",
          config.workspacePath,
          "--",
          "bash",
          scriptPath,
        );
        const paneId = parsePaneId(paneStdout);

        return {
          id: config.sessionId,
          runtimeName: "zellij",
          data: {
            createdAt: Date.now(),
            workspacePath: config.workspacePath,
            zellijSessionName: sessionName,
            paneId,
          },
        };
      } catch (err: unknown) {
        try {
          await zellij("kill-session", sessionName);
        } catch {
          // Best-effort cleanup
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to start Zellij pane for session "${sessionName}": ${msg}`, {
          cause: err,
        });
      }
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      try {
        await zellij("kill-session", getZellijSessionName(handle));
      } catch {
        // Session may already be gone.
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const paneId = String(handle.data.paneId ?? "");
      if (!paneId) {
        throw new Error(`Missing Zellij pane id for session ${handle.id}`);
      }
      const sessionName = getZellijSessionName(handle);

      await zellij("--session", sessionName, "action", "send-keys", "--pane-id", paneId, "Ctrl u");
      await zellij("--session", sessionName, "action", "paste", "--pane-id", paneId, "--", message);
      await sleep(300);
      await zellij("--session", sessionName, "action", "send-keys", "--pane-id", paneId, "Enter");
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      const paneId = String(handle.data.paneId ?? "");
      if (!paneId) return "";

      try {
        const output = await zellij(
          "--session",
          getZellijSessionName(handle),
          "action",
          "dump-screen",
          "--pane-id",
          paneId,
          "--full",
        );
        const allLines = output.split(/\r?\n/);
        return allLines.slice(Math.max(0, allLines.length - lines)).join("\n");
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      return sessionExists(getZellijSessionName(handle));
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const createdAt = (handle.data.createdAt as number) ?? Date.now();
      return {
        uptimeMs: Date.now() - createdAt,
      };
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      const sessionName = getZellijSessionName(handle);
      return {
        type: "zellij",
        target: sessionName,
        command: `zellij attach ${sessionName}`,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
