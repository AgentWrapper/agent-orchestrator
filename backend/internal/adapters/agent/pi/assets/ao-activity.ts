// agent-orchestrator: managed pi activity extension (do not edit)
//
// Pi discovers project-local extensions from .pi/extensions/*.ts. This
// extension captures Pi's native session UUID from ctx.sessionManager on
// session_start so AO can resume with `pi --session <uuid>`, and maps a small
// lifecycle subset onto AO's normalized hook events.
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOOK_TIMEOUT_MS = 30_000;
const HOOK_COMMANDS: Record<string, string> = {
  "session-start": "ao hooks pi session-start",
  "user-prompt-submit": "ao hooks pi user-prompt-submit",
  stop: "ao hooks pi stop",
  "session-end": "ao hooks pi session-end",
};

export default function aoActivity(pi: ExtensionAPI) {
  function sessionId(ctx: any): string {
    try {
      return String(ctx?.sessionManager?.getSessionId?.() ?? "").trim();
    } catch {
      return "";
    }
  }

  function callHookSync(ctx: any, hookName: string, payload: Record<string, unknown>) {
    const id = sessionId(ctx);
    if (!id) return;

    const body = JSON.stringify({ session_id: id, ...payload }) + "\n";
    const command = HOOK_COMMANDS[hookName];
    if (!command) return;
    try {
      spawnSync("sh", ["-c", `if ! command -v ao >/dev/null 2>&1; then exit 0; fi; exec ${command}`], {
        cwd: ctx?.cwd,
        input: body,
        stdio: ["pipe", "ignore", "ignore"],
        timeout: HOOK_TIMEOUT_MS,
      });
    } catch {
      // Activity reporting is best-effort and must never affect the Pi session.
    }
  }

  pi.on("session_start", (_event, ctx) => {
    callHookSync(ctx, "session-start", {});
  });

  pi.on("before_agent_start", (event, ctx) => {
    callHookSync(ctx, "user-prompt-submit", { prompt: event?.prompt ?? "" });
  });

  pi.on("agent_settled", (_event, ctx) => {
    callHookSync(ctx, "stop", {});
  });

  pi.on("session_shutdown", (event, ctx) => {
    if (event?.reason !== "quit") return;
    callHookSync(ctx, "session-end", { reason: event?.reason ?? "" });
  });
}
