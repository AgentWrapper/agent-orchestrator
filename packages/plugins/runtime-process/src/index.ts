import { spawn, type ChildProcess } from "node:child_process";
import type {
  PluginModule,
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
  AttachInfo,
} from "@aoagents/ao-core";

export const manifest = {
  name: "process",
  slot: "runtime" as const,
  description: "Runtime plugin: child processes",
  version: "0.1.0",
};

/** Only allow safe characters in session IDs */
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

interface ProcessEntry {
  process: ChildProcess | null;
  outputBuffer: string[];
  createdAt: number;
}

const MAX_OUTPUT_LINES = 1000;

export function create(): Runtime {
  // Per-instance process map — each create() call gets its own isolated state
  const processes = new Map<string, ProcessEntry>();

  return {
    name: "process",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(config.sessionId);

      const handleId = config.sessionId;

      // Prevent duplicate session IDs — check and reserve atomically (no await
      // between check and set) so concurrent create() calls can't both pass.
      if (processes.has(handleId)) {
        throw new Error(`Session "${handleId}" already exists — destroy it before re-creating`);
      }

      const entry: ProcessEntry = {
        process: null, // set after spawn — methods guard against null
        outputBuffer: [],
        createdAt: Date.now(),
      };
      processes.set(handleId, entry);

      // NOTE: shell:true is intentional — launchCommand comes from trusted YAML config
      // and may contain pipes, redirects, or other shell syntax.
      let child: ChildProcess;
      try {
        child = spawn(config.launchCommand, {
          cwd: config.workspacePath,
          env: { ...process.env, ...config.environment },
          stdio: ["pipe", "pipe", "pipe"],
          shell: true,
          detached: true, // Own process group so destroy() can kill child commands
        });
      } catch (err: unknown) {
        processes.delete(handleId);
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to spawn process for session ${handleId}: ${msg}`, { cause: err });
      }

      entry.process = child;

      // Attach exit handler immediately — before any await — so fast-exiting
      // processes can't slip through the gap.
      child.once("exit", () => {
        entry.outputBuffer.push(`[process exited with code ${child.exitCode}]`);
        processes.delete(handleId);
      });

      // Handle late errors (process crashes after spawn)
      child.on("error", () => {
        // Already captured via exit handler — prevent unhandled error crash
      });

      // Wait for spawn success or error
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          child.removeListener("spawn", onSpawn);
          processes.delete(handleId);
          reject(new Error(`Failed to spawn process for session ${handleId}: ${err.message}`));
        };
        const onSpawn = () => {
          child.removeListener("error", onError);
          resolve();
        };
        child.once("error", onError);
        child.once("spawn", onSpawn);
      });

      // Capture stdout and stderr into rolling buffer.
      // Each stream gets its own partial-line buffer so interleaved chunks
      // from different streams don't corrupt each other.
      function makeAppendOutput(): (data: Buffer) => void {
        let partial = "";
        return (data: Buffer) => {
          const text = partial + data.toString("utf-8");
          const lines = text.split("\n");
          // Last element is either "" (if text ended with \n) or a partial line
          partial = lines.pop()!;
          for (const line of lines) {
            entry.outputBuffer.push(line);
          }
          // Trim buffer to max size
          if (entry.outputBuffer.length > MAX_OUTPUT_LINES) {
            entry.outputBuffer.splice(0, entry.outputBuffer.length - MAX_OUTPUT_LINES);
          }
        };
      }

      const appendStdout = makeAppendOutput();
      const appendStderr = makeAppendOutput();
      child.stdout?.on("data", appendStdout);
      child.stderr?.on("data", appendStderr);

      // Flush any trailing partial lines when the process exits
      child.once("exit", () => {
        // Trigger flush by sending a final newline through each handler
        appendStdout(Buffer.from("\n"));
        appendStderr(Buffer.from("\n"));
      });

      return {
        id: handleId,
        runtimeName: "process",
        data: {
          pid: child.pid,
          createdAt: entry.createdAt,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      const entry = processes.get(handle.id);
      if (!entry) return;

      const child = entry.process;
      if (!child) {
        // Process hasn't spawned yet — just remove the reservation
        processes.delete(handle.id);
        return;
      }
      if (child.exitCode === null && child.signalCode === null) {
        // Kill the entire process group (negative PID) so child commands
        // spawned by the shell are also terminated, not just the shell itself.
        const pid = child.pid;
        if (pid) {
          try {
            process.kill(-pid, "SIGTERM");
          } catch {
            // Process group may not exist — fall back to direct kill
            child.kill("SIGTERM");
          }
        } else {
          child.kill("SIGTERM");
        }

        // Give it 5 seconds, then SIGKILL — use once() to avoid listener leaks
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              if (pid) {
                try {
                  process.kill(-pid, "SIGKILL");
                } catch {
                  child.kill("SIGKILL");
                }
              } else {
                child.kill("SIGKILL");
              }
            }
            resolve();
          }, 5000);
          child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }

      processes.delete(handle.id);
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const entry = processes.get(handle.id);
      if (!entry) {
        throw new Error(`No process found for session ${handle.id}`);
      }

      const child = entry.process;
      if (!child) {
        throw new Error(`Process for session ${handle.id} is still spawning`);
      }
      const stdin = child.stdin;
      if (!stdin || !stdin.writable) {
        throw new Error(`stdin not writable for session ${handle.id}`);
      }

      // Wrap write in a promise with done-flag to prevent double resolve/reject
      await new Promise<void>((resolve, reject) => {
        let done = false;
        const finish = (err?: Error | null) => {
          if (done) return;
          done = true;
          cleanup();
          if (err) reject(err);
          else resolve();
        };
        const onError = (err: Error) => finish(err);
        const onDrain = () => {
          // Drain means backpressure cleared — still wait for write callback
        };
        const cleanup = () => {
          stdin.removeListener("error", onError);
          stdin.removeListener("drain", onDrain);
        };
        stdin.on("error", onError);
        stdin.on("drain", onDrain);
        stdin.write(message + "\n", (err) => finish(err ?? null));
      });
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      const entry = processes.get(handle.id);
      if (!entry) return "";

      const buffer = entry.outputBuffer;
      const start = Math.max(0, buffer.length - lines);
      return buffer.slice(start).join("\n");
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      const entry = processes.get(handle.id);
      if (!entry || !entry.process) return false;
      return entry.process.exitCode === null && entry.process.signalCode === null;
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const entry = processes.get(handle.id);
      const createdAt = entry?.createdAt ?? Date.now();
      return {
        uptimeMs: Date.now() - createdAt,
      };
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      const entry = processes.get(handle.id);
      if (
        !entry ||
        !entry.process ||
        entry.process.exitCode !== null ||
        entry.process.signalCode !== null
      ) {
        return {
          type: "process",
          target: "",
          command: `# process for session ${handle.id} is no longer running`,
        };
      }
      return {
        type: "process",
        target: String(entry.process.pid),
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
