import { afterAll, beforeAll, describe, expect, it } from "vitest";
import zellijPlugin from "@aoagents/ao-plugin-runtime-zellij";
import type { RuntimeHandle } from "@aoagents/ao-core";
import { sleep } from "./helpers/polling.js";
import { isZellijAvailable, killZellijSessionsByPrefix } from "./helpers/zellij.js";

const zellijOk = await isZellijAvailable();
const SESSION_PREFIX = "aoz-int-";

describe.skipIf(!zellijOk)("runtime-zellij (integration)", () => {
  const runtime = zellijPlugin.create();
  const sessionId = `${SESSION_PREFIX}${Date.now().toString(36)}`;
  let handle: RuntimeHandle;

  beforeAll(async () => {
    await killZellijSessionsByPrefix(SESSION_PREFIX);
  }, 30_000);

  afterAll(async () => {
    try {
      await runtime.destroy(handle);
    } catch {
      // Best-effort cleanup
    }
    await killZellijSessionsByPrefix(SESSION_PREFIX);
  }, 30_000);

  it("creates a Zellij session", async () => {
    handle = await runtime.create({
      sessionId,
      workspacePath: "/tmp",
      launchCommand: "cat",
      environment: { AO_TEST: "1" },
    });

    expect(handle.id).toBe(sessionId);
    expect(handle.runtimeName).toBe("zellij");
    expect(handle.data.paneId).toMatch(/^terminal_\d+$/);
  });

  it("isAlive returns true for running session", async () => {
    expect(await runtime.isAlive(handle)).toBe(true);
  });

  it("sendMessage sends text and getOutput captures it", async () => {
    await runtime.sendMessage(handle, "hello from zellij");
    await sleep(500);
    const output = await runtime.getOutput(handle);
    expect(output).toContain("hello from zellij");
  });

  it("getMetrics returns uptime", async () => {
    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThan(0);
  });

  it("getAttachInfo returns Zellij command", async () => {
    const info = await runtime.getAttachInfo!(handle);
    expect(info.type).toBe("zellij");
    expect(info.target).toBe(sessionId);
    expect(info.command).toContain("zellij attach");
  });

  it("destroy kills the session", async () => {
    await runtime.destroy(handle);
    expect(await runtime.isAlive(handle)).toBe(false);
  });

  it("destroy is idempotent", async () => {
    await runtime.destroy(handle);
  });
});
