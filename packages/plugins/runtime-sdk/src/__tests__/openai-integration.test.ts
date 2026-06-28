/**
 * Live OpenAI integration smoke. Spawns the real host and drives a real turn
 * through the native OpenAI Responses API, asserting the normalized stream.
 *
 * Guarded: runs only when AO_SDK_INTEGRATION=1 AND AO_OPENAI_API_KEY is set.
 * Run after building the plugin:
 *   pnpm --filter @aoagents/ao-plugin-runtime-sdk build
 *   export AO_OPENAI_API_KEY="$(security find-generic-password -s Maestro-provider-keys -a openai -w)"
 *   AO_SDK_INTEGRATION=1 pnpm --filter @aoagents/ao-plugin-runtime-sdk test openai-integration
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "../index.js";
import { subscribeSession } from "../sdk-client.js";
import type { NormalizedEvent } from "../event-schema.js";

const RUN = process.env.AO_SDK_INTEGRATION === "1" && !!process.env.AO_OPENAI_API_KEY;
const distHost = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "sdk-host.js");
const MODEL = process.env.AO_OPENAI_TEST_MODEL ?? "gpt-5.5";

(RUN ? describe : describe.skip)("runtime-sdk OpenAI live integration", () => {
  it(
    "streams a real OpenAI Responses turn through the normalized schema",
    async () => {
      const runtime = create();
      const work = await mkdtemp(join(tmpdir(), "openai-it-"));
      process.env.AO_SDK_HOST_SCRIPT = distHost;

      const events: NormalizedEvent[] = [];
      const handle = await runtime.create({
        sessionId: "openai-it-1",
        workspacePath: work,
        launchCommand: "",
        environment: {
          AO_SDK_PERMISSION_MODE: "bypassPermissions",
          AO_SDK_MODEL: MODEL,
          AO_SDK_PROVIDER: "openai",
          // Pass the key IN config.environment so the per-session strip keeps it.
          AO_OPENAI_API_KEY: process.env.AO_OPENAI_API_KEY!,
          AO_SDK_HOME: join(work, ".sdkstate"),
        },
      });

      await subscribeSession((handle.data as { socketPath: string }).socketPath, (e) => events.push(e));

      const sawResult = new Promise<void>((res) => {
        const t = setInterval(() => {
          if (events.some((e) => e.type === "result")) {
            clearInterval(t);
            res();
          }
        }, 100);
      });
      await runtime.sendMessage(handle, "Reply with exactly one word: PONG");
      await sawResult;

      const init = events.find((e) => e.type === "session" && e.subtype === "init") as
        | { model?: string; session_id?: string }
        | undefined;
      expect(init).toBeDefined();

      const text = events
        .filter((e) => e.type === "text-delta")
        .map((e) => (e as { text: string }).text)
        .join("");
      expect(text.toUpperCase()).toContain("PONG");

      const result = events.find((e) => e.type === "result") as { subtype: string } | undefined;
      expect(result?.subtype).toBe("success");

      const usage = events.find((e) => e.type === "usage") as { output_tokens?: number } | undefined;
      expect(usage).toBeDefined();
      expect((usage!.output_tokens ?? 0)).toBeGreaterThan(0);

      await runtime.destroy(handle);
      await rm(work, { recursive: true, force: true });
    },
    120_000,
  );
});
