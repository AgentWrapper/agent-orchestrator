/**
 * Live integration proof for the PERSISTENT system prompt seam.
 *
 * Verifies that AO_SDK_APPEND_SYSTEM_PROMPT / AO_SDK_SYSTEM_PROMPT_FILE is
 * delivered to the SDK as the appended system prompt AND survives resume — the
 * Anthropic API re-sends the system prompt on every request, so a host restart
 * on the same conversation uuid keeps the persona in effect. This is the fix for
 * orchestrators drifting to generic Claude Code after a daemon restart.
 *
 * Guarded: runs only when AO_SDK_INTEGRATION=1 (needs the user's Claude login).
 *   pnpm --filter @aoagents/ao-plugin-runtime-sdk build
 *   AO_SDK_INTEGRATION=1 pnpm --filter @aoagents/ao-plugin-runtime-sdk test system-prompt-resume
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "../index.js";
import { subscribeSession } from "../sdk-client.js";
import type { NormalizedEvent } from "../event-schema.js";

const RUN = process.env.AO_SDK_INTEGRATION === "1";
const distHost = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "sdk-host.js");

const MARKER = "ROLE_MARKER_7741";
const APPEND = `You are a test agent. When asked your role, reply EXACTLY with this token and nothing else: ${MARKER}`;

(RUN ? describe : describe.skip)("runtime-sdk system prompt persists across resume", () => {
  it(
    "applies AO_SDK_APPEND_SYSTEM_PROMPT and keeps it after a resume",
    async () => {
      const runtime = create();
      const work = await mkdtemp(join(tmpdir(), "sdk-sysprompt-"));
      process.env.AO_SDK_HOST_SCRIPT = distHost;
      const baseEnv = {
        AO_SDK_PERMISSION_MODE: "bypassPermissions",
        AO_SDK_HOME: join(work, ".sdkstate"),
        AO_SDK_APPEND_SYSTEM_PROMPT: APPEND,
      };

      const text = (events: NormalizedEvent[], from: number): string =>
        events
          .slice(from)
          .filter((e) => e.type === "text-delta")
          .map((e) => (e as { text: string }).text)
          .join("");
      const waitResult = (events: NormalizedEvent[]) =>
        new Promise<void>((res) => {
          const start = events.length;
          const t = setInterval(() => {
            if (events.slice(start).some((e) => e.type === "result")) {
              clearInterval(t);
              res();
            }
          }, 100);
        });

      // --- session 1: fresh. The marker exists ONLY in the system prompt; the
      // user turn never mentions it, so a correct answer proves the appended
      // system prompt is in effect. ---
      const events: NormalizedEvent[] = [];
      const handle = await runtime.create({
        sessionId: "it-sysprompt-1",
        workspacePath: work,
        launchCommand: "",
        environment: baseEnv,
      });
      const sub = await subscribeSession(
        (handle.data as { socketPath: string }).socketPath,
        (e) => events.push(e),
      );

      let from = events.length;
      let done = waitResult(events);
      await runtime.sendMessage(handle, "What is your role?");
      await done;
      expect(text(events, from)).toContain(MARKER);

      const init = events.find((e) => e.type === "session" && e.subtype === "init") as
        | { session_id: string }
        | undefined;
      const sdkSessionId = init!.session_id;
      expect(sdkSessionId).toBeTruthy();

      sub.close();
      await runtime.destroy(handle);

      // --- resume: same conversation uuid, fresh host process. session-manager
      // re-provides the same persona env on restore, so we do too. If the marker
      // persists here the appended system prompt survived resume. ---
      const resumeEvents: NormalizedEvent[] = [];
      let resumeHello: { resumed?: boolean; resumed_from?: string } | undefined;
      const handle2 = await runtime.create({
        sessionId: "it-sysprompt-1",
        workspacePath: work,
        launchCommand: "",
        environment: { ...baseEnv, AO_SDK_RESUME: sdkSessionId },
      });
      const sub2 = await subscribeSession(
        (handle2.data as { socketPath: string }).socketPath,
        (e) => resumeEvents.push(e),
        (msg) => {
          if (msg.type === "hello") resumeHello = msg as { resumed?: boolean; resumed_from?: string };
        },
      );

      from = resumeEvents.length;
      done = waitResult(resumeEvents);
      await runtime.sendMessage(handle2, "Remind me — what is your role?");
      await done;

      expect(text(resumeEvents, from)).toContain(MARKER);
      // Genuinely a resume of the same conversation, not a fresh session.
      expect(resumeHello?.resumed).toBe(true);
      expect(resumeHello?.resumed_from).toBe(sdkSessionId);

      sub2.close();
      await runtime.destroy(handle2);
      await rm(work, { recursive: true, force: true });
    },
    180_000,
  );
});
