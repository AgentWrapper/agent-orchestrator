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
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  killProcessTree,
  loadGlobalConfig,
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

/**
 * A host that appended to its event log within this window is provably writing
 * RIGHT NOW — treat it as alive even when the socket `status` probe is momentarily
 * blocked (a dense partial-message stream stalls the host's single event loop past
 * the 2s socket timeout) and even when this handle carries no/stale PID. Without
 * this, a busy streaming host gets a false `dead`/`probe_failed` verdict that
 * cascades into stuck and the promptless end→resume loop.
 */
const EVENT_LOG_FRESH_MS = 10_000;

/** True when the event log was appended to within `maxAgeMs` (host writing now). */
function eventLogIsFresh(eventLogPath: string | undefined, maxAgeMs: number): boolean {
  if (!eventLogPath) return false;
  try {
    return Date.now() - statSync(eventLogPath).mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

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
      // AO_GLM_API_KEY is also stripped: it's provider-level auth that must be
      // set explicitly per-session from the global config, not inherited from the
      // orchestrator's environment (same "inherited secret bleeds into workers" risk).
      for (const key of ["AO_SDK_RESUME", "AO_SDK_INITIAL_PROMPT", "AO_SDK_MODEL", "AO_SDK_PERMISSION_MODE", "AO_GLM_API_KEY", "AO_GLM_BASE_URL", "AO_MIMO_API_KEY", "AO_MIMO_BASE_URL"]) {
        if (!config.environment || !(key in config.environment)) {
          delete hostEnv[key];
        }
      }

      // Inject the GLM API key from the global config (zhipu.apiKey) when the
      // per-session model is a `glm-*` model and the key was not already set
      // explicitly in config.environment. This bridges the gap between the
      // user's Settings → ZhipuAI config and the sdk-host process, which reads
      // AO_GLM_API_KEY at runtime (sdk-host.ts) to take the GLM path.
      //
      // The session model arrives via AO_SDK_MODEL (RuntimeCreateConfig has no
      // `model` field); sdk-host derives `model` from process.env.AO_SDK_MODEL.
      const sessionModel = config.environment?.["AO_SDK_MODEL"];
      if (
        sessionModel?.startsWith("glm-") &&
        (!config.environment || !config.environment["AO_GLM_API_KEY"])
      ) {
        const zhipuCfg = loadGlobalConfig()?.zhipu;
        const glmKey = zhipuCfg?.apiKey;
        if (glmKey) {
          hostEnv["AO_GLM_API_KEY"] = glmKey;
        }
        const glmBaseUrl = zhipuCfg?.baseUrl;
        if (glmBaseUrl && (!config.environment || !config.environment["AO_GLM_BASE_URL"])) {
          hostEnv["AO_GLM_BASE_URL"] = glmBaseUrl;
        }
      }

      // Inject the MiMo API key from the global config (mimo.apiKey) when the
      // per-session model is a `mimo-*` model and the key was not already set
      // explicitly in config.environment. Same pattern as GLM/Zhipu above.
      if (
        sessionModel?.startsWith("mimo-") &&
        (!config.environment || !config.environment["AO_MIMO_API_KEY"])
      ) {
        const mimoCfg = loadGlobalConfig()?.mimo;
        const mimoKey = mimoCfg?.apiKey;
        if (mimoKey) {
          hostEnv["AO_MIMO_API_KEY"] = mimoKey;
        }
        const mimoBaseUrl = mimoCfg?.baseUrl;
        if (mimoBaseUrl && (!config.environment || !config.environment["AO_MIMO_BASE_URL"])) {
          hostEnv["AO_MIMO_BASE_URL"] = mimoBaseUrl;
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
      // Reachability = socket OK || PID alive || event log fresh. ANY positive
      // signal means the host is up; only the absence of ALL of them is "dead".
      // The host's input is an unbounded FIFO, so a reachable host can always
      // accept a turn — this is the liveness the poller and `ao send` rely on.
      if (await hostIsAlive(data.socketPath)) return true;
      // Socket unreachable — fall back to a PID liveness probe.
      if (typeof data.hostPid === "number" && data.hostPid > 0) {
        try {
          process.kill(data.hostPid, 0);
          return true;
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
          // PID gone — fall through to the event-log check rather than declaring
          // death: a just-resumed host may not have its new PID reflected in this
          // (possibly thin) handle yet, but it is still appending events.
        }
      }
      // Final signal: a host actively appending events is alive+busy even when the
      // socket probe timed out under load and we have no usable PID.
      return eventLogIsFresh(data.eventLogPath, EVENT_LOG_FRESH_MS);
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
