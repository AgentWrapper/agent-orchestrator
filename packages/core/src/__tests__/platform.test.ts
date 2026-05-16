import { describe, it, expect, afterEach } from "vitest";

describe("platform adapter", () => {
  const originalPlatform = process.platform;

  afterEach(async () => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    // Reset the shell cache after each test so platform changes take effect
    const mod = await import("../platform.js");
    mod._resetShellCache();
  });

  function setPlatform(p: string) {
    Object.defineProperty(process, "platform", { value: p });
  }

  describe("isWindows", () => {
    it("returns true on win32", async () => {
      setPlatform("win32");
      const mod = await import("../platform.js");
      mod._resetShellCache();
      expect(mod.isWindows()).toBe(true);
    });

    it("returns false on linux", async () => {
      setPlatform("linux");
      const mod = await import("../platform.js");
      mod._resetShellCache();
      expect(mod.isWindows()).toBe(false);
    });
  });

  describe("getDefaultRuntime", () => {
    it("returns 'process' on win32", async () => {
      setPlatform("win32");
      const mod = await import("../platform.js");
      expect(mod.getDefaultRuntime()).toBe("process");
    });

    it("returns 'tmux' on linux", async () => {
      setPlatform("linux");
      const mod = await import("../platform.js");
      expect(mod.getDefaultRuntime()).toBe("tmux");
    });
  });

  describe("getShell", () => {
    it("always returns /bin/sh on unix (ignores $SHELL)", async () => {
      setPlatform("linux");
      const mod = await import("../platform.js");
      mod._resetShellCache();
      const shell = mod.getShell();
      // getShell() must always return /bin/sh on Unix regardless of $SHELL,
      // so that postCreate commands and runtime launches work correctly even
      // when the user's login shell is fish, nushell, or other non-POSIX shells.
      expect(shell.cmd).toBe("/bin/sh");
      expect(shell.args("echo hi")).toEqual(["-c", "echo hi"]);
    });

    it("returns powershell or cmd on win32", async () => {
      setPlatform("win32");
      const mod = await import("../platform.js");
      mod._resetShellCache();
      const shell = mod.getShell();
      expect(shell.cmd).toMatch(/pwsh|powershell|cmd/i);
    });
  });

  describe("getEnvDefaults", () => {
    it("returns Unix-style defaults on linux", async () => {
      setPlatform("linux");
      const mod = await import("../platform.js");
      const env = mod.getEnvDefaults();
      expect(env.TMPDIR).toBe(process.env.TMPDIR || "/tmp");
    });

    it("returns Windows-style defaults on win32", async () => {
      setPlatform("win32");
      const mod = await import("../platform.js");
      const env = mod.getEnvDefaults();
      expect(env.TMPDIR).toBe(process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp");
    });
  });
});
