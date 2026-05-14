import { describe, it, expect, vi, afterEach } from "vitest";

describe("config defaults", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    vi.resetModules();
  });

  it("defaults runtime to 'process' on win32", async () => {
    vi.resetModules();
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    const { getDefaultConfig } = await import("../config.js");
    const config = getDefaultConfig();
    expect(config.defaults.runtime).toBe("process");
  });

  it("defaults runtime to 'tmux' on linux", async () => {
    vi.resetModules();
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    const { getDefaultConfig } = await import("../config.js");
    const config = getDefaultConfig();
    expect(config.defaults.runtime).toBe("tmux");
  });
});
