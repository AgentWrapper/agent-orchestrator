import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PluginModule,
  type Runtime,
  type RuntimeCreateConfig,
  type RuntimeHandle,
  type RuntimeMetrics,
  type AttachInfo,
  shellEscape,
} from "@aoagents/ao-core";

const execFileAsync = promisify(execFile);
const TMUX_COMMAND_TIMEOUT_MS = 5_000;

export const manifest = {
  name: "tmux",
  slot: "runtime" as const,
  description: "Runtime plugin: tmux sessions",
  version: "0.1.0",
};

/** Only allow safe characters in session IDs */
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

function writeLaunchScript(command: string): string {
  const scriptPath = join(tmpdir(), `ao-launch-${randomUUID()}.sh`);
  const content = `#!/usr/bin/env bash\nrm -- "$0" 2>/dev/null || true\n${command}\n`;
  writeFileSync(scriptPath, content, { encoding: "utf-8", mode: 0o700 });
  return `bash ${shellEscape(scriptPath)}`;
}

/** Run a tmux command and return stdout */
async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, {
    timeout: TMUX_COMMAND_TIMEOUT_MS,
  });
  return stdout.trimEnd();
}

export function create(): Runtime {
  return {
    name: "tmux",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(config.sessionId);
      const sessionName = config.sessionId;

      // Build environment flags: -e KEY=VALUE for each env var
      const envArgs: string[] = [];
      for (const [key, value] of Object.entries(config.environment ?? {})) {
        envArgs.push("-e", `${key}=${value}`);
      }

      // Create tmux session in detached mode
      await tmux("new-session", "-d", "-s", sessionName, "-c", config.workspacePath, ...envArgs);

      // Re-export PATH inside the launch script. macOS zsh runs path_helper
      // during shell startup which resets PATH, wiping entries set via tmux -e.
      // Including the export in the script file (not send-keys) avoids terminal
      // buffer issues with long PATH values (1000+ chars).
      const pathValue = config.environment?.["PATH"];
      let launchCommand = config.launchCommand;
      if (pathValue) {
        // Use printf with JSON-escaped value to avoid shell injection if
        // PATH contains single quotes or other shell metacharacters.
        launchCommand = `export PATH=$(printf '%s' ${JSON.stringify(pathValue)})\n${launchCommand}`;
      }

      // Send the launch command — clean up the session if this fails.
      // Use a temp script for long commands so the pane shows a short
      // invocation instead of a pasted wall of shell.
      try {
        if (launchCommand.length > 200) {
          const invocation = writeLaunchScript(launchCommand);
          await tmux("send-keys", "-t", sessionName, "-l", invocation);
          await sleep(300);
          await tmux("send-keys", "-t", sessionName, "Enter");
        } else {
          await tmux("send-keys", "-t", sessionName, launchCommand, "Enter");
        }
      } catch (err: unknown) {
        try {
          await tmux("kill-session", "-t", sessionName);
        } catch {
          // Best-effort cleanup
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to send launch command to session "${sessionName}": ${msg}`, {
          cause: err,
        });
      }

      return {
        id: sessionName,
        runtimeName: "tmux",
        data: {
          createdAt: Date.now(),
          workspacePath: config.workspacePath,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      try {
        await tmux("kill-session", "-t", handle.id);
      } catch {
        // Session may already be dead — that's fine
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      // Clear any partial input
      await tmux("send-keys", "-t", handle.id, "C-u");

      // For long or multiline messages, use load-buffer + paste-buffer
      // Use randomUUID to avoid temp file collisions on concurrent sends
      if (message.includes("\n") || message.length > 200) {
        const bufferName = `ao-${randomUUID()}`;
        const tmpPath = join(tmpdir(), `ao-send-${randomUUID()}.txt`);
        writeFileSync(tmpPath, message, { encoding: "utf-8", mode: 0o600 });
        try {
          await tmux("load-buffer", "-b", bufferName, tmpPath);
          await tmux("paste-buffer", "-b", bufferName, "-t", handle.id, "-d");
        } finally {
          // Clean up temp file and tmux buffer (in case paste-buffer failed
          // and the -d flag didn't delete it)
          try {
            unlinkSync(tmpPath);
          } catch {
            // ignore cleanup errors
          }
          try {
            await tmux("delete-buffer", "-b", bufferName);
          } catch {
            // Buffer may already be deleted by -d flag — that's fine
          }
        }
      } else {
        // Use -l (literal) so text like "Enter" or "Space" isn't interpreted
        // as tmux key names
        await tmux("send-keys", "-t", handle.id, "-l", message);
      }

      // Small delay to let tmux process the pasted text before pressing Enter.
      // Without this, Enter can arrive before the text is fully rendered.
      await sleep(300);
      await tmux("send-keys", "-t", handle.id, "Enter");
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      try {
        return await tmux("capture-pane", "-t", handle.id, "-p", "-S", `-${lines}`);
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      try {
        await tmux("has-session", "-t", handle.id);
        return true;
      } catch {
        return false;
      }
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const createdAt = (handle.data.createdAt as number) ?? Date.now();
      return {
        uptimeMs: Date.now() - createdAt,
      };
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      return {
        type: "tmux",
        target: handle.id,
        command: `tmux attach -t ${handle.id}`,
      };
    },

    async preflight(): Promise<void> {
      try {
        await execFileAsync("tmux", ["-V"], { timeout: TMUX_COMMAND_TIMEOUT_MS });
      } catch {
        const hint =
          process.platform === "darwin"
            ? "brew install tmux"
            : process.platform === "win32"
              ? "tmux is not available on Windows. Use WSL: wsl --install, then: sudo apt install tmux"
              : "sudo apt install tmux (Debian/Ubuntu) or sudo dnf install tmux (Fedora)";
        throw new Error(`tmux is not installed. Install it: ${hint}`);
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
