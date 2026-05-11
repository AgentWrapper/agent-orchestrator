import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted so they're available before module import
// ---------------------------------------------------------------------------

const { mockExistsSync, mockReadFileSync, mockWriteFileSync, mockUnlinkSync, mockMkdirSync } =
  vi.hoisted(() => ({
    mockExistsSync: vi.fn<(path: string) => boolean>(),
    mockReadFileSync: vi.fn<(path: string, encoding: string) => string>(),
    mockWriteFileSync: vi.fn(),
    mockUnlinkSync: vi.fn(),
    mockMkdirSync: vi.fn(),
  }));

const { mockExecFileSync, mockExecFile } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockExecFile: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === "function") {
      callback(null, "", "");
    }
    return null;
  }),
}));

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(args[0] as string),
    readFileSync: (...args: unknown[]) => mockReadFileSync(args[0] as string, args[1] as string),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  };
});

const { mockGetCliVersion } = vi.hoisted(() => ({
  mockGetCliVersion: vi.fn(() => "0.2.2"),
}));

vi.mock("../../src/options/version.js", () => ({
  getCliVersion: () => mockGetCliVersion(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  classifyInstallPath,
  detectInstallMethod,
  getCurrentVersion,
  getUpdateCommand,
  getCacheDir,
  readCachedUpdateInfo,
  fetchGitLatestState,
  fetchLatestVersion,
  invalidateCache,
  writeCache,
  checkForUpdate,
  maybeShowUpdateNotice,
  scheduleBackgroundRefresh,
  isVersionOutdated,
} from "../../src/lib/update-check.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("update-check", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockReturnValue("");
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === "function") {
        callback(null, "", "");
      }
      return null;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // isVersionOutdated
  // -----------------------------------------------------------------------

  describe("isVersionOutdated", () => {
    it("returns true when current major is less than latest", () => {
      expect(isVersionOutdated("0.2.2", "1.0.0")).toBe(true);
    });

    it("returns true when current minor is less than latest", () => {
      expect(isVersionOutdated("0.2.2", "0.3.0")).toBe(true);
    });

    it("returns true when current patch is less than latest", () => {
      expect(isVersionOutdated("0.2.2", "0.2.3")).toBe(true);
    });

    it("returns false when versions are equal", () => {
      expect(isVersionOutdated("0.2.2", "0.2.2")).toBe(false);
    });

    it("returns false when current is newer than latest", () => {
      expect(isVersionOutdated("1.0.0", "0.9.9")).toBe(false);
    });

    it("returns false when current minor is greater", () => {
      expect(isVersionOutdated("0.3.0", "0.2.9")).toBe(false);
    });

    it("handles versions with missing patch", () => {
      expect(isVersionOutdated("1.0", "1.0.1")).toBe(true);
    });

    it("treats prerelease current versions as older than the matching stable release", () => {
      expect(isVersionOutdated("0.2.2-beta.1", "0.2.2")).toBe(true);
      expect(isVersionOutdated("0.2.2-rc.1", "0.2.2")).toBe(true);
    });

    it("still compares prerelease versions by numeric parts first", () => {
      expect(isVersionOutdated("0.2.2-beta.1", "0.3.0")).toBe(true);
      expect(isVersionOutdated("0.3.0", "0.3.0-beta.1")).toBe(false);
    });

    it("returns false when pre-release tags produce NaN parts", () => {
      // "beta" alone as a version part → NaN → treated safely
      expect(isVersionOutdated("beta", "1.0.0")).toBe(false);
    });

    it("returns false when both are the same with pre-release", () => {
      expect(isVersionOutdated("0.2.2-rc.1", "0.2.2-rc.2")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // classifyInstallPath
  // -----------------------------------------------------------------------

  describe("classifyInstallPath", () => {
    it("returns 'npm-global' for /usr/local/lib/node_modules path", () => {
      expect(
        classifyInstallPath(
          "/usr/local/lib/node_modules/@aoagents/ao-cli/dist/lib/update-check.js",
        ),
      ).toBe("npm-global");
    });

    it("returns 'npm-global' for nvm global path", () => {
      expect(
        classifyInstallPath(
          "/home/user/.nvm/versions/node/v20.0.0/lib/node_modules/@aoagents/ao-cli/dist/lib/update-check.js",
        ),
      ).toBe("npm-global");
    });

    it("returns 'npm-global' for Windows global path", () => {
      expect(
        classifyInstallPath(
          "C:\\Users\\test\\AppData\\Roaming\\npm\\lib\\node_modules\\@aoagents\\ao-cli\\dist\\lib\\update-check.js",
        ),
      ).toBe("npm-global");
    });

    it("returns 'pnpm-global' for pnpm global store path", () => {
      expect(
        classifyInstallPath(
          "/home/user/.local/share/pnpm/global/5/node_modules/.pnpm/@aoagents+ao-cli@0.2.2/node_modules/@aoagents/ao-cli/dist/lib/update-check.js",
        ),
      ).toBe("pnpm-global");
    });

    it("returns 'unknown' for local pnpm node_modules/.pnpm (not global)", () => {
      mockExistsSync.mockReturnValue(false);
      expect(
        classifyInstallPath(
          "/home/user/my-project/node_modules/.pnpm/@aoagents+ao-cli@0.2.2/node_modules/@aoagents/ao-cli/dist/lib/update-check.js",
        ),
      ).toBe("unknown");
    });

    it("returns 'unknown' for local project node_modules (npx)", () => {
      mockExistsSync.mockReturnValue(false);
      expect(
        classifyInstallPath(
          "/home/user/my-project/node_modules/@aoagents/ao-cli/dist/lib/update-check.js",
        ),
      ).toBe("unknown");
    });

    it("returns 'git' when repo root has .git", () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path.endsWith(".git")) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(JSON.stringify({ name: "@aoagents/ao" }));

      expect(
        classifyInstallPath("/home/user/agent-orchestrator/packages/cli/src/lib/update-check.ts"),
      ).toBe("git");
    });

    it("returns 'unknown' for a non-AO repo even when .git exists four levels up", () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path.endsWith(".git")) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(JSON.stringify({ name: "not-ao" }));

      expect(
        classifyInstallPath("/home/user/other-monorepo/packages/cli/src/lib/update-check.ts"),
      ).toBe("unknown");
    });

    it("returns 'unknown' when .git does not exist at the resolved repo root", () => {
      mockExistsSync.mockReturnValue(false);
      expect(classifyInstallPath("/tmp/random/path/update-check.ts")).toBe("unknown");
    });
  });

  // -----------------------------------------------------------------------
  // detectInstallMethod (integration — uses real import.meta.url)
  // -----------------------------------------------------------------------

  describe("detectInstallMethod", () => {
    it("returns a valid InstallMethod", () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path.endsWith(".git")) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(JSON.stringify({ name: "@aoagents/ao" }));

      const result = detectInstallMethod();
      expect(["git", "npm-global", "unknown"]).toContain(result);
    });
  });

  // -----------------------------------------------------------------------
  // getCurrentVersion
  // -----------------------------------------------------------------------

  describe("getCurrentVersion", () => {
    it("returns a valid semver version string", () => {
      const version = getCurrentVersion();
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  // -----------------------------------------------------------------------
  // getUpdateCommand
  // -----------------------------------------------------------------------

  describe("getUpdateCommand", () => {
    it("returns 'ao update' for git installs", () => {
      expect(getUpdateCommand("git")).toBe("ao update");
    });

    it("returns npm install command for npm-global installs", () => {
      expect(getUpdateCommand("npm-global")).toBe("npm install -g @aoagents/ao@latest");
    });

    it("returns pnpm add command for pnpm-global installs", () => {
      expect(getUpdateCommand("pnpm-global")).toBe("pnpm add -g @aoagents/ao@latest");
    });

    it("returns npm install command for unknown installs", () => {
      expect(getUpdateCommand("unknown")).toBe("npm install -g @aoagents/ao@latest");
    });
  });

  // -----------------------------------------------------------------------
  // getCacheDir
  // -----------------------------------------------------------------------

  describe("getCacheDir", () => {
    it("uses XDG_CACHE_HOME when set", () => {
      const origXdg = process.env["XDG_CACHE_HOME"];
      process.env["XDG_CACHE_HOME"] = "/custom/cache";

      const dir = getCacheDir();
      expect(dir).toMatch(/^[\\/]custom[\\/]cache[\\/]ao$/);

      if (origXdg !== undefined) process.env["XDG_CACHE_HOME"] = origXdg;
      else delete process.env["XDG_CACHE_HOME"];
    });

    it("falls back to ~/.cache when XDG_CACHE_HOME is not set", () => {
      const origXdg = process.env["XDG_CACHE_HOME"];
      delete process.env["XDG_CACHE_HOME"];

      const dir = getCacheDir();
      expect(dir).toContain(".cache");
      expect(dir).toMatch(/[\\/]ao$/);

      if (origXdg !== undefined) process.env["XDG_CACHE_HOME"] = origXdg;
    });
  });

  // -----------------------------------------------------------------------
  // readCachedUpdateInfo
  // -----------------------------------------------------------------------

  describe("readCachedUpdateInfo", () => {
    it("returns null when no cache file exists", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      expect(readCachedUpdateInfo()).toBeNull();
    });

    it("returns cached data when fresh and version matches", () => {
      const now = new Date().toISOString();
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "0.3.0",
          checkedAt: now,
          currentVersionAtCheck: currentVersion,
          installMethod: "unknown",
        }),
      );

      const result = readCachedUpdateInfo();
      expect(result).not.toBeNull();
      expect(result!.latestVersion).toBe("0.3.0");
    });

    it("returns null when cache is expired (>24h)", () => {
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "0.3.0",
          checkedAt: old,
          currentVersionAtCheck: currentVersion,
          installMethod: "unknown",
        }),
      );
      expect(readCachedUpdateInfo()).toBeNull();
    });

    it("returns cached data when cache is just under 24h old", () => {
      const recent = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "0.3.0",
          checkedAt: recent,
          currentVersionAtCheck: currentVersion,
          installMethod: "unknown",
        }),
      );
      expect(readCachedUpdateInfo()).not.toBeNull();
    });

    it("returns null when currentVersionAtCheck differs (manual upgrade)", () => {
      const now = new Date().toISOString();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "0.5.0",
          checkedAt: now,
          currentVersionAtCheck: "9.9.9",
          installMethod: "unknown",
        }),
      );
      expect(readCachedUpdateInfo()).toBeNull();
    });

    it("returns null on invalid JSON", () => {
      mockReadFileSync.mockReturnValue("not json{{{");
      expect(readCachedUpdateInfo()).toBeNull();
    });

    it("returns null when latestVersion is missing", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ checkedAt: new Date().toISOString() }));
      expect(readCachedUpdateInfo()).toBeNull();
    });

    it("returns null when checkedAt is missing", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ latestVersion: "1.0.0" }));
      expect(readCachedUpdateInfo()).toBeNull();
    });

    it("returns null on empty string cache file", () => {
      mockReadFileSync.mockReturnValue("");
      expect(readCachedUpdateInfo()).toBeNull();
    });

    it("returns null when cache install method differs", () => {
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "0.3.0",
          checkedAt: new Date().toISOString(),
          currentVersionAtCheck: currentVersion,
          installMethod: "npm-global",
        }),
      );
      expect(readCachedUpdateInfo("pnpm-global")).toBeNull();
    });

    it("treats legacy cache entries without installMethod as unsafe for all installs", () => {
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "0.3.0",
          checkedAt: new Date().toISOString(),
          currentVersionAtCheck: currentVersion,
        }),
      );
      expect(readCachedUpdateInfo("git")).toBeNull();
      expect(readCachedUpdateInfo("npm-global")).toBeNull();
      expect(readCachedUpdateInfo("pnpm-global")).toBeNull();
      expect(readCachedUpdateInfo("unknown")).toBeNull();
    });

    it("returns null when git cache was checked at a different HEAD", () => {
      const currentVersion = getCurrentVersion();
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "new-head\n";
        return "";
      });
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "origin/main",
          checkedAt: new Date().toISOString(),
          currentVersionAtCheck: currentVersion,
          installMethod: "git",
          isOutdated: true,
          currentRevisionAtCheck: "old-head",
        }),
      );

      expect(readCachedUpdateInfo("git")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // writeCache
  // -----------------------------------------------------------------------

  describe("writeCache", () => {
    it("writes valid JSON to the cache path", () => {
      mockMkdirSync.mockImplementation(() => undefined);
      mockWriteFileSync.mockImplementation(() => undefined);

      writeCache({
        latestVersion: "0.3.0",
        checkedAt: new Date().toISOString(),
        currentVersionAtCheck: "0.2.2",
      });

      expect(mockMkdirSync).toHaveBeenCalledWith(expect.stringContaining("ao"), {
        recursive: true,
      });
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(written.latestVersion).toBe("0.3.0");
    });

    it("does not throw when cache dir is unwritable", () => {
      mockMkdirSync.mockImplementation(() => {
        throw new Error("EACCES");
      });

      expect(() =>
        writeCache({
          latestVersion: "0.3.0",
          checkedAt: new Date().toISOString(),
          currentVersionAtCheck: "0.2.2",
        }),
      ).not.toThrow();
    });

    it("does not throw when writeFileSync fails", () => {
      mockMkdirSync.mockImplementation(() => undefined);
      mockWriteFileSync.mockImplementation(() => {
        throw new Error("ENOSPC");
      });

      expect(() =>
        writeCache({
          latestVersion: "0.3.0",
          checkedAt: new Date().toISOString(),
          currentVersionAtCheck: "0.2.2",
        }),
      ).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // fetchGitLatestState
  // -----------------------------------------------------------------------

  describe("fetchGitLatestState", () => {
    it("returns not behind when HEAD matches origin/main", async () => {
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === "rev-parse") return "abc123\n";
        return "";
      });

      const state = await fetchGitLatestState("/repo");

      expect(state).toEqual({
        ref: "origin/main",
        headRevision: "abc123",
        latestRevision: "abc123",
        isBehind: false,
      });
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["fetch", "origin", "main"],
        expect.objectContaining({ cwd: "/repo" }),
        expect.any(Function),
      );
    });

    it("returns behind when HEAD is an ancestor of origin/main", async () => {
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "local\n";
        if (args[0] === "rev-parse" && args[1] === "origin/main") return "remote\n";
        return "";
      });

      const state = await fetchGitLatestState("/repo");

      expect(state?.isBehind).toBe(true);
      expect(state?.latestRevision).toBe("remote");
    });

    it("returns null when git commands fail", async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("git failed");
      });

      await expect(fetchGitLatestState("/repo")).resolves.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // fetchLatestVersion
  // -----------------------------------------------------------------------

  describe("fetchLatestVersion", () => {
    it("returns version string from registry", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "0.3.0" }),
      });

      const version = await fetchLatestVersion();
      expect(version).toBe("0.3.0");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://registry.npmjs.org/@aoagents%2Fao/latest",
        expect.objectContaining({ headers: { Accept: "application/json" } }),
      );
    });

    it("passes an AbortSignal for timeout", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "1.0.0" }),
      });
      await fetchLatestVersion();
      expect(mockFetch.mock.calls[0][1]).toHaveProperty("signal");
    });

    it("returns null on non-ok response", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404 });
      expect(await fetchLatestVersion()).toBeNull();
    });

    it("returns null on 500 server error", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 });
      expect(await fetchLatestVersion()).toBeNull();
    });

    it("returns null on network error", async () => {
      mockFetch.mockRejectedValue(new Error("fetch failed"));
      expect(await fetchLatestVersion()).toBeNull();
    });

    it("returns null on timeout (AbortError)", async () => {
      mockFetch.mockRejectedValue(new DOMException("signal timed out", "TimeoutError"));
      expect(await fetchLatestVersion()).toBeNull();
    });

    it("returns null on non-JSON response", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error("invalid json");
        },
      });
      expect(await fetchLatestVersion()).toBeNull();
    });

    it("returns null when version field is missing", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ name: "@aoagents/ao" }),
      });
      expect(await fetchLatestVersion()).toBeNull();
    });

    it("returns null when version field is not a string", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: 123 }),
      });
      expect(await fetchLatestVersion()).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // invalidateCache
  // -----------------------------------------------------------------------

  describe("invalidateCache", () => {
    it("calls unlinkSync on cache path", () => {
      mockUnlinkSync.mockImplementation(() => {});
      invalidateCache();
      expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining("update-check.json"));
    });

    it("does not throw when cache file does not exist", () => {
      mockUnlinkSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      expect(() => invalidateCache()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // checkForUpdate
  // -----------------------------------------------------------------------

  describe("checkForUpdate", () => {
    it("uses cache when fresh and does not call fetch", async () => {
      const now = new Date().toISOString();
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "99.0.0",
          checkedAt: now,
          currentVersionAtCheck: currentVersion,
          installMethod: "npm-global",
        }),
      );
      mockExistsSync.mockReturnValue(false);

      const info = await checkForUpdate({ installMethod: "npm-global" });
      expect(info.isOutdated).toBe(true);
      expect(info.latestVersion).toBe("99.0.0");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("bypasses cache when force: true", async () => {
      const now = new Date().toISOString();
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "0.3.0",
          checkedAt: now,
          currentVersionAtCheck: currentVersion,
        }),
      );
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "0.4.0" }),
      });

      const info = await checkForUpdate({ force: true });
      expect(mockFetch).toHaveBeenCalled();
      expect(info.latestVersion).toBe("0.4.0");
    });

    it("fetches from registry when no cache exists", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "0.3.0" }),
      });

      const info = await checkForUpdate();
      expect(info.latestVersion).toBe("0.3.0");
      expect(mockFetch).toHaveBeenCalled();
    });

    it("writes cache after successful fetch", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "0.3.0" }),
      });

      await checkForUpdate();

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(written.latestVersion).toBe("0.3.0");
      expect(written.currentVersionAtCheck).toBe(getCurrentVersion());
      expect(written.installMethod).toBe("unknown");
    });

    it("does NOT write cache when fetch fails", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockRejectedValue(new Error("network error"));

      await checkForUpdate();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("returns isOutdated=false when versions match", async () => {
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: currentVersion }),
      });

      const info = await checkForUpdate({ force: true });
      expect(info.isOutdated).toBe(false);
    });

    it("returns isOutdated=false and latestVersion=null when registry unreachable", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockRejectedValue(new Error("network error"));

      const info = await checkForUpdate();
      expect(info.isOutdated).toBe(false);
      expect(info.latestVersion).toBeNull();
      expect(info.checkedAt).toBeNull();
    });

    it("includes installMethod and recommendedCommand", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "0.3.0" }),
      });

      const info = await checkForUpdate();
      expect(["git", "npm-global", "unknown"]).toContain(info.installMethod);
      expect(typeof info.recommendedCommand).toBe("string");
      expect(info.recommendedCommand.length).toBeGreaterThan(0);
    });

    it("uses cached npm-global data for npm-global installs", async () => {
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.endsWith("update-check.json")) {
          return JSON.stringify({
            latestVersion: "0.3.0",
            checkedAt: new Date().toISOString(),
            currentVersionAtCheck: currentVersion,
            installMethod: "npm-global",
          });
        }
        return JSON.stringify({ name: "not-ao" });
      });

      const info = await checkForUpdate({ installMethod: "npm-global" });

      expect(info.latestVersion).toBe("0.3.0");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("uses npm registry and npm-global command for npm-global installs", async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.endsWith("update-check.json")) throw new Error("ENOENT");
        return JSON.stringify({ name: "not-ao" });
      });
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "0.3.0" }),
      });

      const info = await checkForUpdate({ force: true, installMethod: "npm-global" });
      expect(info.installMethod).toBe("npm-global");
      expect(info.latestVersion).toBe("0.3.0");
      expect(info.recommendedCommand).toBe("npm install -g @aoagents/ao@latest");
    });

    it("uses npm registry and pnpm-global command for pnpm-global installs", async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.endsWith("update-check.json")) throw new Error("ENOENT");
        return JSON.stringify({ name: "not-ao" });
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "0.3.0" }),
      });

      const info = await checkForUpdate({ force: true, installMethod: "pnpm-global" });
      expect(info.installMethod).toBe("pnpm-global");
      expect(info.latestVersion).toBe("0.3.0");
      expect(info.recommendedCommand).toBe("pnpm add -g @aoagents/ao@latest");
    });

    it("uses cached git state without consulting npm registry", async () => {
      const currentVersion = getCurrentVersion();
      mockExistsSync.mockImplementation((path: string) => path.endsWith(".git"));
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc\n";
        return "";
      });
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.endsWith("update-check.json")) {
          return JSON.stringify({
            latestVersion: "origin/main",
            checkedAt: new Date().toISOString(),
            currentVersionAtCheck: currentVersion,
            installMethod: "git",
            isOutdated: false,
            currentRevisionAtCheck: "abc",
            latestRevisionAtCheck: "abc",
          });
        }
        return JSON.stringify({ name: "@aoagents/ao" });
      });

      const info = await checkForUpdate();

      expect(info.installMethod).toBe("git");
      expect(info.isOutdated).toBe(false);
      expect(info.latestVersion).toBe("origin/main");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("checks git source installs against origin/main when cache is stale", async () => {
      mockExistsSync.mockImplementation((path: string) => path.endsWith(".git"));
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.endsWith("update-check.json")) throw new Error("ENOENT");
        return JSON.stringify({ name: "@aoagents/ao" });
      });
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "local\n";
        if (args[0] === "rev-parse" && args[1] === "origin/main") return "remote\n";
        return "";
      });

      const info = await checkForUpdate({ force: true, installMethod: "git", repoRoot: "/repo" });

      expect(info.installMethod).toBe("git");
      expect(info.isOutdated).toBe(true);
      expect(info.latestVersion).toBe("origin/main");
      expect(info.recommendedCommand).toBe("ao update");
      expect(mockFetch).not.toHaveBeenCalled();
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(written.installMethod).toBe("git");
      expect(written.isOutdated).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // maybeShowUpdateNotice
  // -----------------------------------------------------------------------

  describe("maybeShowUpdateNotice", () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;
    let origIsTTY: boolean | undefined;
    let origCI: string | undefined;
    let origAOCI: string | undefined;
    let origNotifier: string | undefined;
    let origArgv: string[];

    beforeEach(() => {
      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      origIsTTY = process.stderr.isTTY;
      origCI = process.env["CI"];
      origAOCI = process.env["AGENT_ORCHESTRATOR_CI"];
      origNotifier = process.env["AO_NO_UPDATE_NOTIFIER"];
      origArgv = process.argv;
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      delete process.env["CI"];
      delete process.env["AGENT_ORCHESTRATOR_CI"];
      delete process.env["AO_NO_UPDATE_NOTIFIER"];
      process.argv = ["node", "ao", "start"];
    });

    afterEach(() => {
      Object.defineProperty(process.stderr, "isTTY", { value: origIsTTY, configurable: true });
      if (origCI !== undefined) process.env["CI"] = origCI;
      else delete process.env["CI"];
      if (origAOCI !== undefined) process.env["AGENT_ORCHESTRATOR_CI"] = origAOCI;
      else delete process.env["AGENT_ORCHESTRATOR_CI"];
      if (origNotifier !== undefined) process.env["AO_NO_UPDATE_NOTIFIER"] = origNotifier;
      else delete process.env["AO_NO_UPDATE_NOTIFIER"];
      process.argv = origArgv;
    });

    it("prints update notice when cache shows outdated version", () => {
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "99.0.0",
          checkedAt: new Date().toISOString(),
          currentVersionAtCheck: currentVersion,
          installMethod: "unknown",
        }),
      );

      maybeShowUpdateNotice();

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const output = stderrSpy.mock.calls[0]![0] as string;
      expect(output).toContain("Update available");
      expect(output).toContain("99.0.0");
      expect(output).toContain("npm install -g @aoagents/ao@latest");
    });

    it("prints git update notice from cached git state", () => {
      const currentVersion = getCurrentVersion();
      mockExistsSync.mockImplementation((path: string) => path.endsWith(".git"));
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "local\n";
        return "";
      });
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.endsWith("update-check.json")) {
          return JSON.stringify({
            latestVersion: "origin/main",
            checkedAt: new Date().toISOString(),
            currentVersionAtCheck: currentVersion,
            installMethod: "git",
            isOutdated: true,
            currentRevisionAtCheck: "local",
          });
        }
        return JSON.stringify({ name: "@aoagents/ao" });
      });

      maybeShowUpdateNotice();

      const output = stderrSpy.mock.calls[0]![0] as string;
      expect(output).toContain("Update available from origin/main");
      expect(output).toContain("Run: ao update");
      expect(output).not.toContain("99.0.0");
    });

    it("does not print when versions match (not outdated)", () => {
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: currentVersion,
          checkedAt: new Date().toISOString(),
          currentVersionAtCheck: currentVersion,
        }),
      );
      maybeShowUpdateNotice();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("does not print when no cache exists", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      maybeShowUpdateNotice();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("does not print when stderr is not a TTY", () => {
      Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
      maybeShowUpdateNotice();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("does not print when AO_NO_UPDATE_NOTIFIER=1", () => {
      process.env["AO_NO_UPDATE_NOTIFIER"] = "1";
      maybeShowUpdateNotice();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("does not print when CI=true", () => {
      process.env["CI"] = "true";
      maybeShowUpdateNotice();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("does not print when AGENT_ORCHESTRATOR_CI is set", () => {
      process.env["AGENT_ORCHESTRATOR_CI"] = "1";
      maybeShowUpdateNotice();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it.each(["update", "doctor", "--version", "-V", "--help", "-h"])(
      "does not print when argv includes '%s'",
      (arg) => {
        process.argv = ["node", "ao", arg];
        maybeShowUpdateNotice();
        expect(stderrSpy).not.toHaveBeenCalled();
      },
    );
  });

  // -----------------------------------------------------------------------
  // scheduleBackgroundRefresh
  // -----------------------------------------------------------------------

  describe("scheduleBackgroundRefresh", () => {
    it("does not throw and schedules a timer", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "0.3.0" }),
      });

      expect(() => scheduleBackgroundRefresh()).not.toThrow();
    });

    it("swallows errors from checkForUpdate", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockRejectedValue(new Error("network fail"));

      expect(() => scheduleBackgroundRefresh()).not.toThrow();
    });
  });
});
