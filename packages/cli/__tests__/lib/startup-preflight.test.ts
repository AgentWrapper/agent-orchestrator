import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mockAskYesNo, mockExecSilent } = vi.hoisted(() => ({
  mockAskYesNo: vi.fn(),
  mockExecSilent: vi.fn(),
}));

vi.mock("../../src/lib/install-helpers.js", () => ({
  askYesNo: mockAskYesNo,
  tryInstallWithAttempts: vi.fn(async () => false),
}));

vi.mock("../../src/lib/shell.js", () => ({
  execSilent: mockExecSilent,
}));

import { ensureTmux } from "../../src/lib/startup-preflight.js";

let tmpDir: string;
let originalPlatform: PropertyDescriptor | undefined;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-preflight-test-"));
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  mockAskYesNo.mockReset();
  mockExecSilent.mockReset();
});

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("ensureTmux on Windows", () => {
  it("rewrites runtime: tmux -> runtime: process when user accepts", async () => {
    setPlatform("win32");
    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    const original = [
      "port: 3000",
      "defaults:",
      "  runtime: tmux",
      "  agent: claude-code",
      "projects: {}",
      "",
    ].join("\n");
    writeFileSync(configPath, original, "utf-8");

    mockAskYesNo.mockResolvedValueOnce(true);

    const result = await ensureTmux(configPath);
    expect(result.switchedToProcess).toBe(true);

    const after = readFileSync(configPath, "utf-8");
    expect(after).toContain("runtime: process");
    expect(after).not.toContain("runtime: tmux");
    // Surrounding lines preserved
    expect(after).toContain("agent: claude-code");
    expect(after).toContain("port: 3000");
  });

  it("preserves quoting when rewriting", async () => {
    setPlatform("win32");
    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, 'defaults:\n  runtime: "tmux"\n  agent: claude-code\n', "utf-8");

    mockAskYesNo.mockResolvedValueOnce(true);
    const result = await ensureTmux(configPath);
    expect(result.switchedToProcess).toBe(true);

    const after = readFileSync(configPath, "utf-8");
    expect(after).toContain("runtime: process");
  });

  it("preserves trailing comments when rewriting", async () => {
    setPlatform("win32");
    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "defaults:\n  runtime: tmux  # legacy default\n", "utf-8");

    mockAskYesNo.mockResolvedValueOnce(true);
    const result = await ensureTmux(configPath);
    expect(result.switchedToProcess).toBe(true);

    const after = readFileSync(configPath, "utf-8");
    expect(after).toContain("runtime: process  # legacy default");
  });

  it("exits when user declines the rewrite", async () => {
    setPlatform("win32");
    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "defaults:\n  runtime: tmux\n", "utf-8");

    mockAskYesNo.mockResolvedValueOnce(false);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__process_exit__");
    }) as never);

    await expect(ensureTmux(configPath)).rejects.toThrow("__process_exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);

    // File untouched
    const after = readFileSync(configPath, "utf-8");
    expect(after).toContain("runtime: tmux");
  });

  it("exits without prompting when configPath is missing", async () => {
    setPlatform("win32");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__process_exit__");
    }) as never);

    await expect(ensureTmux()).rejects.toThrow("__process_exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockAskYesNo).not.toHaveBeenCalled();
  });

  it("does not invoke tmux -V on Windows", async () => {
    setPlatform("win32");
    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "defaults:\n  runtime: tmux\n", "utf-8");
    mockAskYesNo.mockResolvedValueOnce(true);

    await ensureTmux(configPath);
    expect(mockExecSilent).not.toHaveBeenCalled();
  });
});

describe("ensureTmux on Linux when tmux is present", () => {
  it("returns without prompting", async () => {
    setPlatform("linux");
    mockExecSilent.mockResolvedValueOnce("tmux 3.3a");
    const result = await ensureTmux();
    expect(result.switchedToProcess).toBe(false);
    expect(mockAskYesNo).not.toHaveBeenCalled();
  });
});
