/**
 * Unit tests for decomposer module — LLM provider abstraction, thinking-tag
 * stripping, config validation, and MiniMax integration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatLineage,
  formatSiblings,
  getLeaves,
  getSiblings,
  formatPlanTree,
  propagateStatus,
  stripThinkingTags,
  createLLMClient,
  DEFAULT_DECOMPOSER_CONFIG,
} from "../decomposer.js";
import type { TaskNode, DecomposerConfig } from "../decomposer.js";

// =============================================================================
// HELPER FACTORIES
// =============================================================================

function makeTaskNode(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: "1",
    depth: 0,
    description: "Test task",
    status: "pending",
    lineage: [],
    children: [],
    ...overrides,
  };
}

// =============================================================================
// stripThinkingTags
// =============================================================================

describe("stripThinkingTags", () => {
  it("removes single thinking block", () => {
    const input = '<think>Let me analyze this...</think>atomic';
    expect(stripThinkingTags(input)).toBe("atomic");
  });

  it("removes multiple thinking blocks", () => {
    const input = '<think>First thought</think>some text<think>Second thought</think>result';
    expect(stripThinkingTags(input)).toBe("some textresult");
  });

  it("handles multiline thinking blocks", () => {
    const input = `<think>
Let me think about this carefully.
This task involves multiple concerns.
</think>
composite`;
    expect(stripThinkingTags(input)).toBe("composite");
  });

  it("preserves text without thinking tags", () => {
    const input = '["Build API endpoint", "Create frontend form"]';
    expect(stripThinkingTags(input)).toBe('["Build API endpoint", "Create frontend form"]');
  });

  it("handles empty thinking tags", () => {
    const input = "<think></think>atomic";
    expect(stripThinkingTags(input)).toBe("atomic");
  });

  it("handles empty string input", () => {
    expect(stripThinkingTags("")).toBe("");
  });

  it("strips thinking before JSON array output", () => {
    const input =
      '<think>This is a composite task with backend and frontend work</think>["Implement REST API", "Build React UI"]';
    const result = stripThinkingTags(input);
    expect(result).toBe('["Implement REST API", "Build React UI"]');
    expect(() => JSON.parse(result)).not.toThrow();
  });
});

// =============================================================================
// createLLMClient
// =============================================================================

describe("createLLMClient", () => {
  it("creates anthropic client by default", () => {
    const client = createLLMClient();
    expect(client).toBeDefined();
    expect(typeof client.chatCompletion).toBe("function");
  });

  it("creates anthropic client explicitly", () => {
    const client = createLLMClient("anthropic");
    expect(client).toBeDefined();
    expect(typeof client.chatCompletion).toBe("function");
  });

  it("throws when creating minimax client without API key", () => {
    const original = process.env["MINIMAX_API_KEY"];
    delete process.env["MINIMAX_API_KEY"];

    expect(() => createLLMClient("minimax")).toThrow("MINIMAX_API_KEY");

    if (original) process.env["MINIMAX_API_KEY"] = original;
  });

  it("creates minimax client when API key is set", () => {
    const original = process.env["MINIMAX_API_KEY"];
    process.env["MINIMAX_API_KEY"] = "test-key-123";

    const client = createLLMClient("minimax");
    expect(client).toBeDefined();
    expect(typeof client.chatCompletion).toBe("function");

    if (original) {
      process.env["MINIMAX_API_KEY"] = original;
    } else {
      delete process.env["MINIMAX_API_KEY"];
    }
  });
});

// =============================================================================
// MiniMax client — fetch-based tests
// =============================================================================

describe("MiniMax LLM client", () => {
  const originalKey = process.env["MINIMAX_API_KEY"];
  const originalBaseURL = process.env["MINIMAX_BASE_URL"];

  beforeEach(() => {
    process.env["MINIMAX_API_KEY"] = "test-minimax-key";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    if (originalKey) {
      process.env["MINIMAX_API_KEY"] = originalKey;
    } else {
      delete process.env["MINIMAX_API_KEY"];
    }
    if (originalBaseURL) {
      process.env["MINIMAX_BASE_URL"] = originalBaseURL;
    } else {
      delete process.env["MINIMAX_BASE_URL"];
    }
    vi.restoreAllMocks();
  });

  it("sends correct request to MiniMax API", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "atomic" } }],
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = createLLMClient("minimax");
    const result = await client.chatCompletion({
      model: "MiniMax-M3",
      maxTokens: 10,
      system: "You are a classifier.",
      userMessage: "Classify this task.",
    });

    expect(result).toBe("atomic");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.minimax.io/v1/chat/completions");
    expect(options.method).toBe("POST");

    const headers = options.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-minimax-key");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(options.body as string);
    expect(body.model).toBe("MiniMax-M3");
    expect(body.max_tokens).toBe(10);
    expect(body.temperature).toBeGreaterThanOrEqual(0);
    expect(body.temperature).toBeLessThanOrEqual(1);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
  });

  it("strips thinking tags from MiniMax response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: "<think>Let me analyze...</think>composite",
                },
              },
            ],
          }),
      }),
    );

    const client = createLLMClient("minimax");
    const result = await client.chatCompletion({
      model: "MiniMax-M3",
      maxTokens: 10,
      system: "Classify.",
      userMessage: "Task.",
    });

    expect(result).toBe("composite");
  });

  it("handles MiniMax API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"error":"invalid_api_key"}'),
      }),
    );

    const client = createLLMClient("minimax");
    await expect(
      client.chatCompletion({
        model: "MiniMax-M3",
        maxTokens: 10,
        system: "Classify.",
        userMessage: "Task.",
      }),
    ).rejects.toThrow("MiniMax API error (401)");
  });

  it("respects custom MINIMAX_BASE_URL", async () => {
    process.env["MINIMAX_BASE_URL"] = "https://custom-proxy.example.com/v1";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "atomic" } }],
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = createLLMClient("minimax");
    await client.chatCompletion({
      model: "MiniMax-M3",
      maxTokens: 10,
      system: "Classify.",
      userMessage: "Task.",
    });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://custom-proxy.example.com/v1/chat/completions");
  });

  it("returns decomposition JSON from MiniMax", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content:
                    '<think>Breaking this into parts...</think>["Build REST API", "Create React frontend"]',
                },
              },
            ],
          }),
      }),
    );

    const client = createLLMClient("minimax");
    const result = await client.chatCompletion({
      model: "MiniMax-M3",
      maxTokens: 1024,
      system: "Decompose.",
      userMessage: "Build a full-stack app.",
    });

    const parsed = JSON.parse(result);
    expect(parsed).toEqual(["Build REST API", "Create React frontend"]);
  });

  it("handles empty choices from MiniMax", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [],
          }),
      }),
    );

    const client = createLLMClient("minimax");
    const result = await client.chatCompletion({
      model: "MiniMax-M3",
      maxTokens: 10,
      system: "Classify.",
      userMessage: "Task.",
    });

    expect(result).toBe("");
  });
});

// =============================================================================
// DEFAULT_DECOMPOSER_CONFIG
// =============================================================================

describe("DEFAULT_DECOMPOSER_CONFIG", () => {
  it("has expected defaults", () => {
    expect(DEFAULT_DECOMPOSER_CONFIG).toEqual({
      enabled: false,
      maxDepth: 3,
      model: "claude-sonnet-4-20250514",
      requireApproval: true,
      provider: "anthropic",
    });
  });
});

// =============================================================================
// Config schema — provider field
// =============================================================================

describe("DecomposerConfig provider field", () => {
  it("accepts anthropic provider", async () => {
    const { validateConfig } = await import("../config.js");
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          decomposer: {
            enabled: true,
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
          },
        },
      },
    });

    expect(config.projects.proj1.decomposer?.provider).toBe("anthropic");
  });

  it("accepts minimax provider", async () => {
    const { validateConfig } = await import("../config.js");
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          decomposer: {
            enabled: true,
            provider: "minimax",
            model: "MiniMax-M3",
          },
        },
      },
    });

    expect(config.projects.proj1.decomposer?.provider).toBe("minimax");
    expect(config.projects.proj1.decomposer?.model).toBe("MiniMax-M3");
  });

  it("defaults provider to anthropic", async () => {
    const { validateConfig } = await import("../config.js");
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          decomposer: {
            enabled: true,
          },
        },
      },
    });

    expect(config.projects.proj1.decomposer?.provider).toBe("anthropic");
  });

  it("rejects invalid provider", async () => {
    const { validateConfig } = await import("../config.js");
    expect(() =>
      validateConfig({
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
            decomposer: {
              enabled: true,
              provider: "invalid-provider",
            },
          },
        },
      }),
    ).toThrow();
  });
});

// =============================================================================
// EXISTING PURE FUNCTION TESTS
// =============================================================================

describe("formatLineage", () => {
  it("formats empty lineage with current task", () => {
    const result = formatLineage([], "Build auth module");
    expect(result).toBe("0. Build auth module  <-- (this task)");
  });

  it("formats deep lineage hierarchy", () => {
    const result = formatLineage(["Full-stack app", "Backend services"], "Auth endpoint");
    expect(result).toContain("0. Full-stack app");
    expect(result).toContain("  1. Backend services");
    expect(result).toContain("    2. Auth endpoint  <-- (this task)");
  });
});

describe("formatSiblings", () => {
  it("returns empty string for no siblings", () => {
    expect(formatSiblings([], "Task")).toBe("");
  });

  it("marks current task with arrow", () => {
    const result = formatSiblings(["Backend", "Frontend"], "Backend");
    expect(result).toContain("Backend  <-- (you)");
    expect(result).toContain("  - Frontend");
  });
});

describe("getLeaves", () => {
  it("returns single node when no children", () => {
    const node = makeTaskNode();
    expect(getLeaves(node)).toEqual([node]);
  });

  it("returns all leaf nodes from nested tree", () => {
    const tree = makeTaskNode({
      id: "1",
      children: [
        makeTaskNode({
          id: "1.1",
          children: [
            makeTaskNode({ id: "1.1.1", description: "Leaf A" }),
            makeTaskNode({ id: "1.1.2", description: "Leaf B" }),
          ],
        }),
        makeTaskNode({ id: "1.2", description: "Leaf C" }),
      ],
    });

    const leaves = getLeaves(tree);
    expect(leaves).toHaveLength(3);
    expect(leaves.map((l) => l.description)).toEqual(["Leaf A", "Leaf B", "Leaf C"]);
  });
});

describe("getSiblings", () => {
  it("returns empty for root task", () => {
    const root = makeTaskNode({ id: "1" });
    expect(getSiblings(root, "1")).toEqual([]);
  });

  it("returns sibling descriptions", () => {
    const root = makeTaskNode({
      id: "1",
      children: [
        makeTaskNode({ id: "1.1", description: "Backend" }),
        makeTaskNode({ id: "1.2", description: "Frontend" }),
        makeTaskNode({ id: "1.3", description: "Tests" }),
      ],
    });

    const siblings = getSiblings(root, "1.2");
    expect(siblings).toEqual(["Backend", "Tests"]);
  });
});

describe("propagateStatus", () => {
  it("marks parent done when all children done", () => {
    const tree = makeTaskNode({
      children: [
        makeTaskNode({ status: "done" }),
        makeTaskNode({ status: "done" }),
      ],
    });

    propagateStatus(tree);
    expect(tree.status).toBe("done");
  });

  it("marks parent failed when any child failed", () => {
    const tree = makeTaskNode({
      children: [
        makeTaskNode({ status: "done" }),
        makeTaskNode({ status: "failed" }),
      ],
    });

    propagateStatus(tree);
    expect(tree.status).toBe("failed");
  });

  it("marks parent running when some children done", () => {
    const tree = makeTaskNode({
      children: [
        makeTaskNode({ status: "done" }),
        makeTaskNode({ status: "pending" }),
      ],
    });

    propagateStatus(tree);
    expect(tree.status).toBe("running");
  });

  it("does not change status for leaf nodes", () => {
    const leaf = makeTaskNode({ status: "pending" });
    propagateStatus(leaf);
    expect(leaf.status).toBe("pending");
  });
});

describe("formatPlanTree", () => {
  it("formats atomic leaf node", () => {
    const node = makeTaskNode({
      id: "1.1",
      kind: "atomic",
      description: "Build API",
      status: "ready",
    });

    const result = formatPlanTree(node);
    expect(result).toContain("[ATOMIC]");
    expect(result).toContain("Build API");
  });

  it("formats composite tree with children", () => {
    const tree = makeTaskNode({
      id: "1",
      kind: "composite",
      description: "Full-stack app",
      status: "ready",
      children: [
        makeTaskNode({ id: "1.1", kind: "atomic", description: "Backend", status: "ready" }),
        makeTaskNode({ id: "1.2", kind: "atomic", description: "Frontend", status: "ready" }),
      ],
    });

    const result = formatPlanTree(tree);
    expect(result).toContain("[COMPOSITE]");
    expect(result).toContain("Full-stack app");
    expect(result).toContain("[ATOMIC]");
    expect(result).toContain("Backend");
    expect(result).toContain("Frontend");
  });
});
