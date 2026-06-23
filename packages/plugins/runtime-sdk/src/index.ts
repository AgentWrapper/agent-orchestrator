/**
 * runtime-sdk — drives Claude via @anthropic-ai/claude-agent-sdk.
 *
 * The FIRST streaming runtime adapter: no terminal, no PTY. A long-lived HOST
 * process (sdk-host.js, spawned detached so it survives orchestrator/Maestro
 * restarts) owns the streaming `query()` session, writes a per-session NDJSON
 * event log, and fans normalized events out to live subscribers over a Unix
 * socket / named pipe. This plugin is the client side of that host.
 *
 * Implements the ao `Runtime` interface. `getAttachInfo` is intentionally
 * OMITTED — there is no terminal to attach a human to; the UI subscribes to the
 * live event stream instead (see sdk-client.ts `subscribeSession`).
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  killProcessTree,
  type PluginModule,
  type Runtime,
  type RuntimeCreateConfig,
  type RuntimeHandle,
  type RuntimeMetrics,
} from "@aoagents/ao-core";
import { assertValidSessionId, sessionPaths } from "./protocol.js";
import { hostSend, hostGetOutput, hostIsAlive, hostKill } from "./sdk-client.js";

export const manifest = {
  name: "sdk",
  slot: "runtime" as const,
  description: "Runtime plugin: Claude via the Agent SDK (no terminal; streaming events)",
  version: "0.1.0",
};

interface HandleData {
  aoSessionId: string;
  socketPath: string;
  eventLogPath: string;
  sessionInfoPath: string;
  hostPid: number;
  createdAt: number;
}

function handleData(handle: RuntimeHandle): HandleData {
  return handle.data as unknown as HandleData;
}

const HOST_STARTUP_TIMEOUT_MS = 15_000;

export function create(): Runtime {
  return {
    name: "sdk",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(config.sessionId);

      // The host inherits config.environment (which may carry AO_SDK_INITIAL_PROMPT,
      // AO_SDK_PERMISSION_MODE, AO_SDK_RESUME, AO_SDK_MODEL, AO_SDK_HOME) plus the
      // workspace cwd. Derive paths from this SAME merged env so the plugin and
      // the host agree on the socket / log locations.
      const hostEnv: Record<string, string> = {
        ...process.env,
        ...config.environment,
        AO_SDK_CWD: config.workspacePath,
      } as Record<string, string>;
      // AO_SDK_* control vars must come ONLY from config.environment (the per-session intent
      // set by session-manager) — never be inherited from the spawning process. Otherwise a
      // worker spawned by an orchestrator inherits the orchestrator's AO_SDK_RESUME (or
      // INITIAL_PROMPT) from process.env and RESUMES the orchestrator's conversation instead of
      // running its own task — every spawned worker became a copy of the orchestrator once the
      // SDK runtime went live. Strip any inherited value not set explicitly for THIS session.
      for (const key of ["AO_SDK_RESUME", "AO_SDK_INITIAL_PROMPT", "AO_SDK_MODEL", "AO_SDK_PERMISSION_MODE"]) {
        if (!config.environment || !(key in config.environment)) {
          delete hostEnv[key];
        }
      }
      const paths = sessionPaths(config.sessionId, hostEnv);

      // AO_SDK_HOST_SCRIPT lets tests / dev runs point at a prebuilt host
      // (e.g. dist/sdk-host.js) when this module is loaded from TypeScript src.
      const hostScript =
        process.env.AO_SDK_HOST_SCRIPT ||
        resolve(dirname(fileURLToPath(import.meta.url)), "sdk-host.js");

      const child = spawn(process.execPath, [hostScript, config.sessionId], {
        cwd: config.workspacePath,
        env: hostEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // survive parent exit, like the tmux/pty-host daemon
        windowsHide: true,
      });

      // Wait for the host to signal readiness (writes "READY:<id>\n").
      const hostPid = await new Promise<number>((resolveReady, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`sdk-host startup timeout (${HOST_STARTUP_TIMEOUT_MS}ms)`));
        }, HOST_STARTUP_TIMEOUT_MS);
        let buf = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          if (/READY:/.test(buf)) {
            clearTimeout(timer);
            resolveReady(child.pid ?? 0);
          }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
        });
        child.once("error", (err) => {
          clearTimeout(timer);
          reject(new Error(`sdk-host spawn error: ${err.message}`, { cause: err }));
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`sdk-host exited during startup (code ${code}): ${buf}`));
        });
      });

      // Detach so this process can exit while the host keeps running.
      child.unref();
      child.stdout?.destroy();
      child.stderr?.destroy();

      const data: HandleData = {
        aoSessionId: config.sessionId,
        socketPath: paths.socket,
        eventLogPath: paths.eventLog,
        sessionInfoPath: paths.sessionInfo,
        hostPid,
        createdAt: Date.now(),
      };

      return {
        // handle.id = the AO session id. Rationale (documented design fork): the
        // provider session_id is not known until the first user turn produces
        // `init`, so create() cannot return it. The provider id is surfaced in
        // session.json and the `session/init` event the moment it is known, and
        // is the key used for resume (AO_SDK_RESUME).
        id: config.sessionId,
        runtimeName: "sdk",
        data: data as unknown as Record<string, unknown>,
      };
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      await hostSend(handleData(handle).socketPath, message);
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      return hostGetOutput(handleData(handle).socketPath, lines);
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      const data = handleData(handle);
      if (await hostIsAlive(data.socketPath)) return true;
      // Socket unreachable — fall back to a PID liveness probe.
      if (typeof data.hostPid === "number" && data.hostPid > 0) {
        try {
          process.kill(data.hostPid, 0);
          return true;
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
          return false;
        }
      }
      return false;
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      const data = handleData(handle);
      // Ask the host to shut down gracefully, then reap the process tree.
      await hostKill(data.socketPath);
      if (typeof data.hostPid === "number" && data.hostPid > 0) {
        try {
          await killProcessTree(data.hostPid, "SIGTERM");
        } catch {
          /* best effort */
        }
      }
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const data = handleData(handle);
      return { uptimeMs: Date.now() - (data.createdAt ?? Date.now()) };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
