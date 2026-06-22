/**
 * Live integration smoke. Spawns the real host and drives a real multi-turn
 * session through Claude via the Agent SDK, then resumes by id.
 *
 * Guarded: runs only when AO_SDK_INTEGRATION=1 (needs the user's Claude login).
 * Run after building the plugin:
 *   pnpm --filter @aoagents/ao-plugin-runtime-sdk build
 *   AO_SDK_INTEGRATION=1 pnpm --filter @aoagents/ao-plugin-runtime-sdk test
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

(RUN ? describe : describe.skip)("runtime-sdk live integration", () => {
  it(
    "drives a 2-turn streaming session and resumes by id",
    async () => {
      const runtime = create();
      const work = await mkdtemp(join(tmpdir(), "sdk-it-"));
      // The plugin locates the host script from its own process.env (it runs in
      // this process). Under vitest this module loads from src, so point at the
      // prebuilt dist host.
      process.env.AO_SDK_HOST_SCRIPT = distHost;
      const baseEnv = {
        AO_SDK_PERMISSION_MODE: "bypassPermissions",
        AO_SDK_HOME: join(work, ".sdkstate"),
      };

      const events: NormalizedEvent[] = [];
      const sawResult = () =>
        new Promise<void>((res) => {
          const start = events.length;
          const t = setInterval(() => {
            if (events.slice(start).some((e) => e.type === "result")) {
              clearInterval(t);
              res();
            }
          }, 100);
        });

      // --- session 1: two turns ---
      const handle = await runtime.create({
        sessionId: "it-sess-1",
        workspacePath: work,
        launchCommand: "",
        environment: baseEnv,
      });
      const sub = await subscribeSession(
        (handle.data as { socketPath: string }).socketPath,
        (e) => events.push(e),
      );

      let done = sawResult();
      await runtime.sendMessage(handle, "Reply with exactly the word ALPHA and nothing else.");
      await done;

      done = sawResult();
      await runtime.sendMessage(handle, "Now reply with exactly the word BETA and nothing else.");
      await done;

      const results = events.filter((e) => e.type === "result");
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(events.some((e) => e.type === "text-delta")).toBe(true);

      const init = events.find((e) => e.type === "session" && e.subtype === "init") as
        | { session_id: string }
        | undefined;
      expect(init?.session_id).toBeTruthy();
      const sdkSessionId = init!.session_id;

      sub.close();
      await runtime.destroy(handle);

      // --- session 2: resume by provider id ---
      const resumeEvents: NormalizedEvent[] = [];
      const handle2 = await runtime.create({
        sessionId: "it-sess-2",
        workspacePath: work,
        launchCommand: "",
        environment: { ...baseEnv, AO_SDK_RESUME: sdkSessionId },
      });
      const sub2 = await subscribeSession(
        (handle2.data as { socketPath: string }).socketPath,
        (e) => resumeEvents.push(e),
      );

      const resumeDone = new Promise<void>((res) => {
        const t = setInterval(() => {
          if (resumeEvents.some((e) => e.type === "result")) {
            clearInterval(t);
            res();
          }
        }, 100);
      });
      await runtime.sendMessage(
        handle2,
        "What two words did you say earlier, in order? Reply like: ALPHA BETA",
      );
      await resumeDone;

      const finalText = resumeEvents
        .filter((e) => e.type === "text-delta")
        .map((e) => (e as { text: string }).text)
        .join("");
      expect(finalText.toUpperCase()).toContain("ALPHA");
      expect(finalText.toUpperCase()).toContain("BETA");

      sub2.close();
      await runtime.destroy(handle2);
      await rm(work, { recursive: true, force: true });
    },
    180_000,
  );
});
