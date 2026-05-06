import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExistsSync, mockReadFileSync, mockRmSync, mockWriteFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockRmSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  rmSync: mockRmSync,
  writeFileSync: mockWriteFileSync,
}));

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  }),
}));

vi.mock("../../src/lib/shell.js", () => ({
  exec: vi.fn(),
  execSilent: vi.fn(),
}));

import { clearStaleCacheIfNeeded, isInstalledUnderNodeModules } from "../../src/lib/dashboard-rebuild.js";

beforeEach(() => {
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
  mockRmSync.mockReset();
  mockWriteFileSync.mockReset();
});

describe("isInstalledUnderNodeModules", () => {
  it("returns true for paths with node_modules segment", () => {
    expect(isInstalledUnderNodeModules("/usr/local/lib/node_modules/@composio/ao-web")).toBe(true);
  });

  it("returns false for monorepo paths", () => {
    expect(isInstalledUnderNodeModules("/home/user/agent-orchestrator/packages/web")).toBe(false);
  });
});

describe("clearStaleCacheIfNeeded", () => {
  it("does nothing when package.json does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    await clearStaleCacheIfNeeded("/web");
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("does nothing when stamp matches current version", async () => {
    // existsSync: package.json → true, AO_VERSION → true
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes("package.json")) return JSON.stringify({ version: "0.2.2" });
      if (path.includes("AO_VERSION")) return "0.2.2";
      return "";
    });

    await clearStaleCacheIfNeeded("/web");
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("clears cache and updates stamp when version differs", async () => {
    // existsSync: package.json, AO_VERSION, .next/cache, .next → all true
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes("package.json")) return JSON.stringify({ version: "0.3.0" });
      if (path.includes("AO_VERSION")) return "0.2.2";
      return "";
    });

    await clearStaleCacheIfNeeded("/web");
    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining("cache"),
      { recursive: true, force: true },
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("AO_VERSION"),
      "0.3.0",
      "utf8",
    );
  });

  it("clears cache when stamp file is missing (upgrade from old version)", async () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path.includes("AO_VERSION")) return false;
      return true; // package.json, .next/cache, .next all exist
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes("package.json")) return JSON.stringify({ version: "0.3.0" });
      return "";
    });

    await clearStaleCacheIfNeeded("/web");
    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining("cache"),
      { recursive: true, force: true },
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("AO_VERSION"),
      "0.3.0",
      "utf8",
    );
  });

  it("writes stamp but skips rmSync when no cache dir exists", async () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path.includes("cache")) return false;
      if (path.includes("AO_VERSION")) return false;
      return true; // package.json, .next exist
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes("package.json")) return JSON.stringify({ version: "0.3.0" });
      return "";
    });

    await clearStaleCacheIfNeeded("/web");
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("AO_VERSION"),
      "0.3.0",
      "utf8",
    );
  });
});
