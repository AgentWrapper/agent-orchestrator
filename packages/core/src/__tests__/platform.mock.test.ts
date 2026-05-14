/**
 * Extended tests for platform.ts covering mocked child_process paths.
 *
 * These complement platform.test.ts by mocking node:child_process so that
 * Windows-specific branches, error-handling paths, and env-var fallback
 * chains can be exercised on any OS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "node:child_process";
import * as os from "node:os";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock/home"),
  userInfo: vi.fn(() => ({ username: "mockuser" })),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

// Stable mock references — safe across the module cache lifetime.
const mockExecFile = vi.mocked(childProcess.execFile);
const mockExecFileSync = vi.mocked(childProcess.execFileSync);
const mockHomedir = vi.mocked(os.homedir);
const mockUserInfo = vi.mocked(os.userInfo);
const fs = await import("node:fs");
const mockExistsSync = vi.mocked(fs.existsSync);

const originalPlatform = process.platform;

// promisify passes callback as last arg: fn(cmd, args, callback)
// Standard promisify resolves with the first non-error value, so we pass an
// object { stdout, stderr } as that value so destructuring in platform.ts works.
type ExecCb = (err: Error | null, result: { stdout: string; stderr: string }) => void;

// promisify(execFile) calls execFile with (cmd, args, callback) when no options
// are passed, or (cmd, args, options, callback) when options like windowsHide are
// supplied. Pick whichever trailing arg is a function so tests work either way.
function pickCallback(args: unknown[]): ExecCb {
  for (let i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === "function") return args[i] as ExecCb;
  }
  throw new Error("execFile mock: no callback arg found");
}

function resolveExecFile(stdout: string): void {
  mockExecFile.mockImplementationOnce((...args: unknown[]) => {
    pickCallback(args)(null, { stdout, stderr: "" });
    return {} as ReturnType<typeof childProcess.execFile>;
  });
}

function rejectExecFile(err: Error): void {
  mockExecFile.mockImplementationOnce((...args: unknown[]) => {
    pickCallback(args)(err, { stdout: "", stderr: "" });
    return {} as ReturnType<typeof childProcess.execFile>;
  });
}

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, writable: true, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  setPlatform(originalPlatform);
  // Default: absolute powershell path doesn't exist (let probe-based tests run).
  // Specific tests override this when exercising the absolute-path branch.
  mockExistsSync.mockReturnValue(false);
  // AO_SHELL short-circuits auto-detection; clear unless a test sets it.
  delete process.env["AO_SHELL"];
});

afterEach(async () => {
  setPlatform(originalPlatform);
  const mod = await import("../platform.js");
  mod._resetShellCache();
});

// ---------------------------------------------------------------------------
// resolveWindowsShell (tested via getShell)
// ---------------------------------------------------------------------------

describe("resolveWindowsShell", () => {
  beforeEach(async () => {
    const mod = await import("../platform.js");
    mod._resetShellCache();
  });

  it("falls back to powershell.exe via PATH probe when pwsh missing and absolute path missing", async () => {
    setPlatform("win32");
    const savedPath = process.env["PATH"];
    const savedPathExt = process.env["PATHEXT"];
    process.env["PATH"] = "C:\\fake\\bin";
    process.env["PATHEXT"] = ".EXE";

    // pwsh missing on PATH; absolute powershell missing; powershell.exe present on PATH.
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === "C:\\fake\\bin\\powershell.EXE") return true;
      return false;
    });

    try {
      const mod = await import("../platform.js");
      mod._resetShellCache();
      const shell = mod.getShell();

      expect(shell.cmd).toBe("C:\\fake\\bin\\powershell.EXE");
      expect(shell.args("echo hi")).toEqual(["-Command", "echo hi"]);
    } finally {
      if (savedPath !== undefined) process.env["PATH"] = savedPath;
      else delete process.env["PATH"];
      if (savedPathExt !== undefined) process.env["PATHEXT"] = savedPathExt;
      else delete process.env["PATHEXT"];
    }
  });

  it("uses absolute powershell.exe path when pwsh missing and absolute path exists", async () => {
    setPlatform("win32");
    const savedRoot = process.env["SystemRoot"];
    const savedPath = process.env["PATH"];
    const savedPathExt = process.env["PATHEXT"];
    process.env["SystemRoot"] = "C:\\Windows";
    process.env["PATH"] = "C:\\fake\\bin";
    process.env["PATHEXT"] = ".EXE";

    // pwsh missing on PATH; absolute powershell exists.
    mockExistsSync.mockImplementation((p: unknown) => {
      return String(p) === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    });

    try {
      const mod = await import("../platform.js");
      mod._resetShellCache();
      const shell = mod.getShell();

      expect(shell.cmd).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      expect(shell.args("echo hi")).toEqual(["-Command", "echo hi"]);
    } finally {
      if (savedRoot !== undefined) process.env["SystemRoot"] = savedRoot;
      else delete process.env["SystemRoot"];
      if (savedPath !== undefined) process.env["PATH"] = savedPath;
      else delete process.env["PATH"];
      if (savedPathExt !== undefined) process.env["PATHEXT"] = savedPathExt;
      else delete process.env["PATHEXT"];
    }
  });

  it("honors AO_SHELL override before any auto-detection", async () => {
    setPlatform("win32");
    const saved = process.env["AO_SHELL"];
    process.env["AO_SHELL"] = "C:\\custom\\pwsh.exe";

    try {
      const mod = await import("../platform.js");
      mod._resetShellCache();
      const shell = mod.getShell();
      expect(shell.cmd).toBe("C:\\custom\\pwsh.exe");
      expect(shell.args("echo hi")).toEqual(["-Command", "echo hi"]);
      // Auto-detection probes are skipped entirely
      expect(mockExecFileSync).not.toHaveBeenCalled();
    } finally {
      if (saved !== undefined) process.env["AO_SHELL"] = saved;
      else delete process.env["AO_SHELL"];
    }
  });

  it.each([
    ["cmd.exe", ["/c", "echo hi"]],
    ["C:\\Windows\\System32\\cmd.exe", ["/c", "echo hi"]],
    ["bash", ["-c", "echo hi"]],
    ["bash.exe", ["-c", "echo hi"]],
    ["/usr/bin/sh", ["-c", "echo hi"]],
    ["pwsh", ["-Command", "echo hi"]],
    ["powershell.exe", ["-Command", "echo hi"]],
  ])("AO_SHELL=%s infers args from basename", async (override, expectedArgs) => {
    setPlatform("win32");
    const saved = process.env["AO_SHELL"];
    process.env["AO_SHELL"] = override;

    try {
      const mod = await import("../platform.js");
      mod._resetShellCache();
      const shell = mod.getShell();
      expect(shell.cmd).toBe(override);
      expect(shell.args("echo hi")).toEqual(expectedArgs);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    } finally {
      if (saved !== undefined) process.env["AO_SHELL"] = saved;
      else delete process.env["AO_SHELL"];
    }
  });

  it("falls back to cmd.exe when both pwsh and powershell.exe are unavailable", async () => {
    setPlatform("win32");
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const mod = await import("../platform.js");
    mod._resetShellCache();
    const shell = mod.getShell();

    expect(shell.cmd).toMatch(/cmd\.exe/i);
    expect(shell.args("echo hi")).toEqual(["/c", "echo hi"]);
  });

  it("uses ComSpec env var for the cmd fallback when set", async () => {
    setPlatform("win32");
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const savedComSpec = process.env["ComSpec"];
    process.env["ComSpec"] = "C:\\Windows\\System32\\cmd.exe";

    try {
      const mod = await import("../platform.js");
      mod._resetShellCache();
      const shell = mod.getShell();
      expect(shell.cmd).toBe("C:\\Windows\\System32\\cmd.exe");
    } finally {
      if (savedComSpec !== undefined) process.env["ComSpec"] = savedComSpec;
      else delete process.env["ComSpec"];
    }
  });
});

// ---------------------------------------------------------------------------
// killProcessTree
// ---------------------------------------------------------------------------

describe("killProcessTree", () => {
  it("calls taskkill with /T /F /PID for SIGTERM on Windows (always force-kill)", async () => {
    setPlatform("win32");
    resolveExecFile(""); // taskkill succeeds

    const mod = await import("../platform.js");
    await mod.killProcessTree(1234, "SIGTERM");

    // On Windows we always pass /F regardless of signal — taskkill without /F sends
    // WM_CLOSE which is unreliable for headless Node.js console processes.
    expect(mockExecFile).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "1234"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("calls taskkill with /T /F /PID for SIGKILL on Windows", async () => {
    setPlatform("win32");
    resolveExecFile(""); // taskkill succeeds

    const mod = await import("../platform.js");
    await mod.killProcessTree(1234, "SIGKILL");

    expect(mockExecFile).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "1234"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("does not throw when taskkill fails (process already dead)", async () => {
    setPlatform("win32");
    rejectExecFile(new Error("process not found"));

    const mod = await import("../platform.js");
    await expect(mod.killProcessTree(1234)).resolves.toBeUndefined();
  });

  it("sends signal to the process group (negative PID) on Unix", async () => {
    setPlatform("linux");
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    const mod = await import("../platform.js");
    await mod.killProcessTree(5678);

    expect(killSpy).toHaveBeenCalledWith(-5678, "SIGTERM");
    killSpy.mockRestore();
  });

  it("passes SIGKILL through on Unix", async () => {
    setPlatform("linux");
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    const mod = await import("../platform.js");
    await mod.killProcessTree(5678, "SIGKILL");

    expect(killSpy).toHaveBeenCalledWith(-5678, "SIGKILL");
    killSpy.mockRestore();
  });

  it("falls back to direct kill when process-group kill fails on Unix", async () => {
    setPlatform("linux");
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if ((pid as number) < 0) throw new Error("no such process group");
      return true;
    });

    const mod = await import("../platform.js");
    await mod.killProcessTree(9999);

    expect(killSpy).toHaveBeenCalledWith(-9999, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(9999, "SIGTERM");
    killSpy.mockRestore();
  });

  it("does not throw when both Unix kills fail", async () => {
    setPlatform("linux");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("no such process");
    });

    const mod = await import("../platform.js");
    await expect(mod.killProcessTree(9999)).resolves.toBeUndefined();
    killSpy.mockRestore();
  });

  it("returns immediately without killing anything when pid is 0", async () => {
    setPlatform("linux");
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    const mod = await import("../platform.js");
    await mod.killProcessTree(0);

    expect(killSpy).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("returns immediately without killing anything when pid is negative", async () => {
    setPlatform("linux");
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    const mod = await import("../platform.js");
    await mod.killProcessTree(-1);

    expect(killSpy).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// findPidByPort
// ---------------------------------------------------------------------------

describe("findPidByPort", () => {
  it("finds PID from netstat LISTENING line on Windows", async () => {
    setPlatform("win32");
    // netstat -ano output: local address is parts[1], PID is the last part
    const netstatOutput = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       42",
      "  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       99",
    ].join("\n");
    resolveExecFile(netstatOutput);

    const mod = await import("../platform.js");
    const pid = await mod.findPidByPort(3000);

    expect(pid).toBe("42");
  });

  it("does not match port 300 when searching for port 3000 (negative lookahead)", async () => {
    setPlatform("win32");
    // Port 30000 should not match a search for port 3000
    const netstatOutput =
      "  TCP    0.0.0.0:30000          0.0.0.0:0              LISTENING       77\n";
    resolveExecFile(netstatOutput);

    const mod = await import("../platform.js");
    const pid = await mod.findPidByPort(3000);

    expect(pid).toBeNull();
  });

  it("finds PID from IPv6 LISTENING line on Windows", async () => {
    setPlatform("win32");
    // netstat -ano includes IPv6 entries like [::]:3000 when server binds to all interfaces
    const netstatOutput = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    [::]:3000              [::]:0                 LISTENING       55",
    ].join("\n");
    resolveExecFile(netstatOutput);

    const mod = await import("../platform.js");
    const pid = await mod.findPidByPort(3000);

    expect(pid).toBe("55");
  });

  it("returns null when no LISTENING line matches on Windows", async () => {
    setPlatform("win32");
    resolveExecFile("  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       99\n");

    const mod = await import("../platform.js");
    const pid = await mod.findPidByPort(3000);

    expect(pid).toBeNull();
  });

  it("finds PID from lsof output on Unix", async () => {
    setPlatform("linux");
    resolveExecFile("12345\n");

    const mod = await import("../platform.js");
    const pid = await mod.findPidByPort(3000);

    expect(pid).toBe("12345");
    expect(mockExecFile).toHaveBeenCalledWith(
      "lsof",
      ["-ti", ":3000", "-sTCP:LISTEN"],
      expect.any(Function),
    );
  });

  it("returns null when lsof output is empty on Unix", async () => {
    setPlatform("linux");
    resolveExecFile("");

    const mod = await import("../platform.js");
    const pid = await mod.findPidByPort(3000);

    expect(pid).toBeNull();
  });

  it("returns null when lsof output is not a valid PID on Unix", async () => {
    setPlatform("linux");
    resolveExecFile("not-a-pid\n");

    const mod = await import("../platform.js");
    const pid = await mod.findPidByPort(3000);

    expect(pid).toBeNull();
  });

  it("returns null when execFile throws (command not found)", async () => {
    setPlatform("linux");
    rejectExecFile(new Error("command not found: lsof"));

    const mod = await import("../platform.js");
    const pid = await mod.findPidByPort(3000);

    expect(pid).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getEnvDefaults — fallback chains
// ---------------------------------------------------------------------------

describe("getEnvDefaults", () => {
  describe("Windows fallbacks", () => {
    beforeEach(async () => {
      const mod = await import("../platform.js");
      mod._resetShellCache();
      // Default vi.fn() returns undefined (success) so pwsh is picked by getShell()
    });

    it("uses TMP when TEMP is not set", async () => {
      setPlatform("win32");
      const savedTemp = process.env["TEMP"];
      const savedTmp = process.env["TMP"];
      delete process.env["TEMP"];
      process.env["TMP"] = "C:\\Temp";

      try {
        const mod = await import("../platform.js");
        mod._resetShellCache();
        const env = mod.getEnvDefaults();
        expect(env.TMPDIR).toBe("C:\\Temp");
      } finally {
        if (savedTemp !== undefined) process.env["TEMP"] = savedTemp;
        else delete process.env["TEMP"];
        if (savedTmp !== undefined) process.env["TMP"] = savedTmp;
        else delete process.env["TMP"];
      }
    });

    it("uses hardcoded fallback when neither TEMP nor TMP is set", async () => {
      setPlatform("win32");
      const savedTemp = process.env["TEMP"];
      const savedTmp = process.env["TMP"];
      delete process.env["TEMP"];
      delete process.env["TMP"];

      try {
        const mod = await import("../platform.js");
        mod._resetShellCache();
        const env = mod.getEnvDefaults();
        expect(env.TMPDIR).toBe("C:\\Windows\\Temp");
      } finally {
        if (savedTemp !== undefined) process.env["TEMP"] = savedTemp;
        else delete process.env["TEMP"];
        if (savedTmp !== undefined) process.env["TMP"] = savedTmp;
        else delete process.env["TMP"];
      }
    });

    it("uses homedir() when USERPROFILE is not set", async () => {
      setPlatform("win32");
      mockHomedir.mockReturnValue("C:\\Users\\fallback");
      const savedUserProfile = process.env["USERPROFILE"];
      delete process.env["USERPROFILE"];

      try {
        const mod = await import("../platform.js");
        mod._resetShellCache();
        const env = mod.getEnvDefaults();
        expect(env.HOME).toBe("C:\\Users\\fallback");
      } finally {
        if (savedUserProfile !== undefined) process.env["USERPROFILE"] = savedUserProfile;
        else delete process.env["USERPROFILE"];
      }
    });

    it("uses userInfo().username when USERNAME is not set", async () => {
      setPlatform("win32");
      mockUserInfo.mockReturnValue({ username: "winuser" } as ReturnType<typeof os.userInfo>);
      const savedUsername = process.env["USERNAME"];
      delete process.env["USERNAME"];

      try {
        const mod = await import("../platform.js");
        mod._resetShellCache();
        const env = mod.getEnvDefaults();
        expect(env.USER).toBe("winuser");
      } finally {
        if (savedUsername !== undefined) process.env["USERNAME"] = savedUsername;
        else delete process.env["USERNAME"];
      }
    });

    it("uses empty string when PATH is not set on Windows", async () => {
      setPlatform("win32");
      const savedPath = process.env["PATH"];
      delete process.env["PATH"];

      try {
        const mod = await import("../platform.js");
        mod._resetShellCache();
        const env = mod.getEnvDefaults();
        expect(env.PATH).toBe("");
      } finally {
        if (savedPath !== undefined) process.env["PATH"] = savedPath;
        else delete process.env["PATH"];
      }
    });
  });

  describe("Unix fallbacks", () => {
    it("uses homedir() when HOME is not set", async () => {
      setPlatform("linux");
      mockHomedir.mockReturnValue("/home/fallback");
      const savedHome = process.env["HOME"];
      delete process.env["HOME"];

      try {
        const mod = await import("../platform.js");
        const env = mod.getEnvDefaults();
        expect(env.HOME).toBe("/home/fallback");
      } finally {
        if (savedHome !== undefined) process.env["HOME"] = savedHome;
        else delete process.env["HOME"];
      }
    });

    it("uses /bin/bash when SHELL is not set", async () => {
      setPlatform("linux");
      const savedShell = process.env["SHELL"];
      delete process.env["SHELL"];

      try {
        const mod = await import("../platform.js");
        const env = mod.getEnvDefaults();
        expect(env.SHELL).toBe("/bin/bash");
      } finally {
        if (savedShell !== undefined) process.env["SHELL"] = savedShell;
        else delete process.env["SHELL"];
      }
    });

    it("uses /tmp when TMPDIR is not set", async () => {
      setPlatform("linux");
      const savedTmpdir = process.env["TMPDIR"];
      delete process.env["TMPDIR"];

      try {
        const mod = await import("../platform.js");
        const env = mod.getEnvDefaults();
        expect(env.TMPDIR).toBe("/tmp");
      } finally {
        if (savedTmpdir !== undefined) process.env["TMPDIR"] = savedTmpdir;
        else delete process.env["TMPDIR"];
      }
    });

    it("uses default PATH when PATH is not set", async () => {
      setPlatform("linux");
      const savedPath = process.env["PATH"];
      delete process.env["PATH"];

      try {
        const mod = await import("../platform.js");
        const env = mod.getEnvDefaults();
        expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      } finally {
        if (savedPath !== undefined) process.env["PATH"] = savedPath;
        else delete process.env["PATH"];
      }
    });

    it("uses userInfo().username when USER is not set", async () => {
      setPlatform("linux");
      mockUserInfo.mockReturnValue({ username: "fallback_user" } as ReturnType<typeof os.userInfo>);
      const savedUser = process.env["USER"];
      delete process.env["USER"];

      try {
        const mod = await import("../platform.js");
        const env = mod.getEnvDefaults();
        expect(env.USER).toBe("fallback_user");
      } finally {
        if (savedUser !== undefined) process.env["USER"] = savedUser;
        else delete process.env["USER"];
      }
    });
  });
});
