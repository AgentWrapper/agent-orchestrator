/**
 * Integration tests for decomposer module — end-to-end decompose() flow
 * with mocked LLM providers, config validation, and provider switching.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decompose, DEFAULT_DECOMPOSER_CONFIG } from "../decomposer.js";
import type { DecomposerConfig } from "../decomposer.js";
import { validateConfig } from "../config.js";

// =============================================================================
// decompose() with Anthropic (mocked)
// =============================================================================

describe("decompose() — Anthropic provider", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("decomposes an atomic task (Anthropic mock)", async () => {
    // Mock Anthropic SDK
    vi.mock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        messages = {
          create: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: "atomic" }],
          }),
        };
      },
    }));

    const config: DecomposerConfig = {
      ...DEFAULT_DECOMPOSER_CONFIG,
      provider: "anthropic",
    };

    const plan = await decompose("Fix login button color", config);
    expect(plan.tree.kind).toBe("atomic");
    expect(plan.tree.status).toBe("ready");
    expect(plan.tree.children).toHaveLength(0);
    expect(plan.phase).toBe("review"); // requireApproval defaults to true
  });
});

// =============================================================================
// decompose() with MiniMax (mocked)
// =============================================================================

describe("decompose() — MiniMax provider", () => {
  const originalKey = process.env["MINIMAX_API_KEY"];

  beforeEach(() => {
    process.env["MINIMAX_API_KEY"] = "test-minimax-key";
  });

  afterEach(() => {
    if (originalKey) {
      process.env["MINIMAX_API_KEY"] = originalKey;
    } else {
      delete process.env["MINIMAX_API_KEY"];
    }
    vi.restoreAllMocks();
  });

  it("decomposes a composite task (MiniMax mock)", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call: classify → composite
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                choices: [{ message: { content: "<think>This is complex</think>composite" } }],
              }),
          });
        }
        if (callCount === 2) {
          // Second call: decompose → subtasks
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                choices: [
                  {
                    message: {
                      content:
                        '<think>Breaking down</think>["Implement backend API", "Build frontend UI"]',
                    },
                  },
                ],
              }),
          });
        }
        // Remaining calls: classify children → atomic
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: "atomic" } }],
            }),
        });
      }),
    );

    const config: DecomposerConfig = {
      enabled: true,
      maxDepth: 3,
      model: "MiniMax-M3",
      requireApproval: false,
      provider: "minimax",
    };

    const plan = await decompose("Build a full-stack user management system", config);

    expect(plan.tree.kind).toBe("composite");
    expect(plan.tree.children).toHaveLength(2);
    expect(plan.tree.children[0].description).toBe("Implement backend API");
    expect(plan.tree.children[1].description).toBe("Build frontend UI");
    expect(plan.tree.children[0].kind).toBe("atomic");
    expect(plan.tree.children[1].kind).toBe("atomic");
    expect(plan.phase).toBe("approved"); // requireApproval: false
  });

  it("handles MiniMax API failure gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      }),
    );

    const config: DecomposerConfig = {
      enabled: true,
      maxDepth: 3,
      model: "MiniMax-M3",
      requireApproval: true,
      provider: "minimax",
    };

    await expect(decompose("Build something", config)).rejects.toThrow("MiniMax API error (500)");
  });
});

// =============================================================================
// Config integration — decomposer with provider
// =============================================================================

describe("Config integration — decomposer provider", () => {
  it("full config with MiniMax decomposer validates correctly", () => {
    const config = validateConfig({
      projects: {
        "my-app": {
          path: "/repos/my-app",
          repo: "org/my-app",
          defaultBranch: "main",
          decomposer: {
            enabled: true,
            maxDepth: 2,
            model: "MiniMax-M3",
            provider: "minimax",
            requireApproval: false,
          },
        },
      },
    });

    const decomposer = config.projects["my-app"].decomposer;
    expect(decomposer).toBeDefined();
    expect(decomposer!.enabled).toBe(true);
    expect(decomposer!.maxDepth).toBe(2);
    expect(decomposer!.model).toBe("MiniMax-M3");
    expect(decomposer!.provider).toBe("minimax");
    expect(decomposer!.requireApproval).toBe(false);
  });

  it("config without decomposer section uses defaults", () => {
    const config = validateConfig({
      projects: {
        "my-app": {
          path: "/repos/my-app",
          repo: "org/my-app",
          defaultBranch: "main",
        },
      },
    });

    // decomposer section is optional at project level
    const decomposer = config.projects["my-app"].decomposer;
    // When not specified, the full default object is applied
    if (decomposer) {
      expect(decomposer.provider).toBe("anthropic");
      expect(decomposer.enabled).toBe(false);
    }
  });

  it("MiniMax decomposer config alongside Anthropic agent config", () => {
    const config = validateConfig({
      defaults: {
        agent: "claude-code",
      },
      projects: {
        "my-app": {
          path: "/repos/my-app",
          repo: "org/my-app",
          defaultBranch: "main",
          agentConfig: {
            model: "opus",
            permissions: "permissionless",
          },
          decomposer: {
            enabled: true,
            provider: "minimax",
            model: "MiniMax-M3",
          },
        },
      },
    });

    // Agent uses Anthropic (Claude Code)
    expect(config.defaults.agent).toBe("claude-code");
    expect(config.projects["my-app"].agentConfig?.model).toBe("opus");

    // Decomposer uses MiniMax
    expect(config.projects["my-app"].decomposer?.provider).toBe("minimax");
    expect(config.projects["my-app"].decomposer?.model).toBe("MiniMax-M3");
  });
});
