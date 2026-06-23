import { describe, it, expect, afterEach } from "vitest";
import { resolveRuntimeName, agentPreferredRuntime } from "../runtime-resolution.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}
afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
});

const cfg = (runtime?: string, agent?: string) => ({
  defaults: { ...(runtime ? { runtime } : {}), ...(agent ? { agent } : {}) },
});

describe("agentPreferredRuntime", () => {
  it("maps claude-code to sdk, others to undefined", () => {
    expect(agentPreferredRuntime("claude-code")).toBe("sdk");
    expect(agentPreferredRuntime("codex")).toBeUndefined();
    expect(agentPreferredRuntime(undefined)).toBeUndefined();
  });
});

describe("resolveRuntimeName", () => {
  it("claude-code with no runtime resolves to sdk (non-Windows)", () => {
    setPlatform("linux");
    expect(resolveRuntimeName(null, cfg(undefined, "claude-code"), "claude-code")).toBe("sdk");
  });

  it("claude-code resolves to sdk on Windows too (no terminal, cross-platform)", () => {
    setPlatform("win32");
    expect(resolveRuntimeName(null, cfg(undefined, "claude-code"), "claude-code")).toBe("sdk");
  });

  it("a non-Claude agent keeps the platform default", () => {
    setPlatform("linux");
    expect(resolveRuntimeName(null, cfg(undefined, "codex"), "codex")).toBe("tmux");
    setPlatform("win32");
    expect(resolveRuntimeName(null, cfg(undefined, "codex"), "codex")).toBe("process");
  });

  it("no agent falls back to the platform default", () => {
    setPlatform("linux");
    expect(resolveRuntimeName(null, cfg(), undefined)).toBe("tmux");
  });

  it("an explicit project-level runtime always wins (even for claude-code)", () => {
    setPlatform("linux");
    expect(resolveRuntimeName({ runtime: "tmux" }, cfg(undefined, "claude-code"), "claude-code")).toBe(
      "tmux",
    );
    expect(
      resolveRuntimeName({ runtime: "process" }, cfg("sdk", "claude-code"), "claude-code"),
    ).toBe("process");
  });

  it("an explicit defaults runtime differing from the platform default wins", () => {
    setPlatform("linux"); // platform default = tmux
    // user chose process at defaults level → respected, not overridden by sdk
    expect(resolveRuntimeName(null, cfg("process", "claude-code"), "claude-code")).toBe("process");
  });

  it("a defaults runtime equal to the platform default is treated as unconfigured", () => {
    setPlatform("linux"); // platform default = tmux; generators write this value
    // claude-code still gets sdk because tmux here is just the platform default
    expect(resolveRuntimeName(null, cfg("tmux", "claude-code"), "claude-code")).toBe("sdk");
  });

  it("derives the agent from project/config when not passed explicitly", () => {
    setPlatform("linux");
    expect(resolveRuntimeName({ agent: "claude-code" }, cfg(), undefined)).toBe("sdk");
    expect(resolveRuntimeName(null, cfg(undefined, "claude-code"), undefined)).toBe("sdk");
  });
});
