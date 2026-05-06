import { afterAll, describe, expect, it } from "vitest";
import processPlugin from "@aoagents/ao-plugin-runtime-process";
import type { RuntimeHandle } from "@aoagents/ao-core";
import { sleep } from "./helpers/polling.js";

describe("runtime-process (integration)", () => {
  const runtime = processPlugin.create();
  const sessionId = `proc-inttest-${Date.now()}`;
  let handle: RuntimeHandle;

  afterAll(async () => {
    try {
      await runtime.destroy(handle);
    } catch {
      /* best-effort cleanup */
    }
  }, 30_000);

  it("creates a child process", async () => {
    handle = await runtime.create({
      sessionId,
      workspacePath: "/tmp",
      launchCommand: "cat", // cat echoes stdin to stdout
      environment: { AO_TEST: "1" },
    });

    expect(handle.id).toBe(sessionId);
    expect(handle.runtimeName).toBe("process");
    expect(handle.data.pid).toBeTypeOf("number");
  });

  it("isAlive returns true for running process", async () => {
    expect(await runtime.isAlive(handle)).toBe(true);
  });

  it("sendMessage writes to stdin and output is captured", async () => {
    await runtime.sendMessage(handle, "hello from test");
    await sleep(200); // give time for stdout to be captured
    const output = await runtime.getOutput(handle);
    expect(output).toContain("hello from test");
  });

  it("getMetrics returns uptime", async () => {
    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThan(0);
  });

  it("getAttachInfo returns PID", async () => {
    const info = await runtime.getAttachInfo!(handle);
    expect(info.type).toBe("process");
    expect(info.target).toMatch(/^\d+$/);
  });

  it("rejects duplicate session IDs", async () => {
    await expect(
      runtime.create({
        sessionId,
        workspacePath: "/tmp",
        launchCommand: "cat",
        environment: {},
      }),
    ).rejects.toThrow("already exists");
  });

  it("sendMessage throws for unknown session", async () => {
    await expect(
      runtime.sendMessage({ id: "nonexistent", runtimeName: "process", data: {} }, "hi"),
    ).rejects.toThrow("No process found");
  });

  it("destroy kills the process", async () => {
    await runtime.destroy(handle);
    await sleep(200); // give time for exit handler
    expect(await runtime.isAlive(handle)).toBe(false);
  });

  it("getOutput returns empty for destroyed session", async () => {
    const output = await runtime.getOutput(handle);
    expect(output).toBe("");
  });

  it("isAlive returns false for unknown session", async () => {
    expect(await runtime.isAlive({ id: "nonexistent", runtimeName: "process", data: {} })).toBe(
      false,
    );
  });

  it("destroy is idempotent", async () => {
    await runtime.destroy(handle); // should not throw
  });
});
