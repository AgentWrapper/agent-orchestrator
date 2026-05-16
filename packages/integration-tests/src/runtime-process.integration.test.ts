import { afterAll, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import processPlugin from "@aoagents/ao-plugin-runtime-process";
import type { RuntimeHandle } from "@aoagents/ao-core";
import { sleep } from "./helpers/polling.js";

describe("runtime-process (integration)", () => {
  const runtime = processPlugin.create();
  const sessionId = `proc-inttest-${Date.now()}`;
  let handle: RuntimeHandle;

  // Platform-native stdin→stdout echo. We can't use `node -e ...` here:
  // on Windows the launch command goes through `pwsh -Command "..."`, which
  // treats a quoted path as a string literal rather than invoking it, so
  // node never actually runs. `findstr "x*"` matches every line and prints it
  // verbatim — Windows' closest builtin to `cat`.
  const echoCommand = process.platform === "win32" ? `findstr "x*"` : "cat";
  const workspacePath = tmpdir();

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
      workspacePath,
      launchCommand: echoCommand,
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
    // Poll until the payload appears instead of using a fixed sleep: round-trip
    // latency varies wildly across platforms and runners (Unix direct-stdin:
    // ~ms; Windows ConPTY through named pipe + pwsh + findstr startup: hundreds
    // of ms to seconds under AV / cold-cache conditions). A fixed sleep either
    // flakes or wastes time. Polling for the substring (not just non-empty
    // output) is also robust to incidental shell banners arriving first.
    const deadline = Date.now() + 10_000;
    let output = "";
    while (Date.now() < deadline) {
      output = await runtime.getOutput(handle);
      if (output.includes("hello from test")) break;
      await sleep(100);
    }
    expect(output).toContain("hello from test");
  }, 15_000);

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
        workspacePath,
        launchCommand: echoCommand,
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
