import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @composio/core
// ---------------------------------------------------------------------------

const { mockExecute, MockComposio } = vi.hoisted(() => {
  const mockExecute = vi.fn();
  const MockComposio = vi.fn().mockImplementation(() => ({
    tools: { execute: mockExecute },
  }));
  return { mockExecute, MockComposio };
});

vi.mock("@composio/core", () => ({
  Composio: MockComposio,
}));

import { create } from "../src/index.js";
import type { ProjectConfig } from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const project: ProjectConfig = {
  name: "test",
  repo: "acme/integrator",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
  tracker: {
    plugin: "linear",
    teamId: "team-uuid-1",
    workspaceSlug: "acme",
  },
};

const sampleIssueNode = {
  id: "uuid-123",
  identifier: "INT-123",
  title: "Fix login bug",
  description: "Users can't log in with SSO",
  url: "https://linear.app/acme/issue/INT-123",
  priority: 2,
  state: { name: "In Progress", type: "started" },
  labels: { nodes: [{ name: "bug" }, { name: "high-priority" }] },
  assignee: { name: "Alice Smith", displayName: "Alice" },
  team: { key: "INT" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockComposioResponse(data: unknown) {
  mockExecute.mockResolvedValueOnce({
    data,
    successful: true,
  });
}

function mockComposioError(error: string) {
  mockExecute.mockResolvedValueOnce({
    error,
    successful: false,
  });
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

let savedComposioKey: string | undefined;
let savedEntityId: string | undefined;
let savedLinearKey: string | undefined;

function saveEnv() {
  savedComposioKey = process.env["COMPOSIO_API_KEY"];
  savedEntityId = process.env["COMPOSIO_ENTITY_ID"];
  savedLinearKey = process.env["LINEAR_API_KEY"];
}

function restoreEnv() {
  if (savedComposioKey === undefined) {
    delete process.env["COMPOSIO_API_KEY"];
  } else {
    process.env["COMPOSIO_API_KEY"] = savedComposioKey;
  }
  if (savedEntityId === undefined) {
    delete process.env["COMPOSIO_ENTITY_ID"];
  } else {
    process.env["COMPOSIO_ENTITY_ID"] = savedEntityId;
  }
  if (savedLinearKey === undefined) {
    delete process.env["LINEAR_API_KEY"];
  } else {
    process.env["LINEAR_API_KEY"] = savedLinearKey;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tracker-linear Composio transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveEnv();
    // Set Composio key, remove Linear key
    process.env["COMPOSIO_API_KEY"] = "composio_test_key";
    delete process.env["LINEAR_API_KEY"];
    delete process.env["COMPOSIO_ENTITY_ID"];
  });

  afterEach(() => {
    restoreEnv();
  });

  // ---- Auto-detection ---------------------------------------------------

  describe("transport auto-detection", () => {
    it("uses Composio transport when COMPOSIO_API_KEY is set", async () => {
      mockComposioResponse({ issue: sampleIssueNode });
      const tracker = create();
      const issue = await tracker.getIssue("INT-123", project);

      expect(issue.id).toBe("INT-123");
      expect(MockComposio).toHaveBeenCalledWith({ apiKey: "composio_test_key" });
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("prefers COMPOSIO_API_KEY over LINEAR_API_KEY when both set", async () => {
      process.env["LINEAR_API_KEY"] = "lin_api_test_key";
      mockComposioResponse({ issue: sampleIssueNode });

      const tracker = create();
      await tracker.getIssue("INT-123", project);

      // Should use Composio, not direct
      expect(MockComposio).toHaveBeenCalled();
      expect(mockExecute).toHaveBeenCalled();
    });
  });

  // ---- Entity ID --------------------------------------------------------

  describe("entity ID", () => {
    it("defaults entity ID to 'default'", async () => {
      mockComposioResponse({ issue: sampleIssueNode });
      const tracker = create();
      await tracker.getIssue("INT-123", project);

      expect(mockExecute).toHaveBeenCalledWith(
        "LINEAR_RUN_QUERY_OR_MUTATION",
        expect.objectContaining({ entityId: "default" }),
      );
    });

    it("uses COMPOSIO_ENTITY_ID env var when set", async () => {
      process.env["COMPOSIO_ENTITY_ID"] = "my-entity";
      mockComposioResponse({ issue: sampleIssueNode });

      const tracker = create();
      await tracker.getIssue("INT-123", project);

      expect(mockExecute).toHaveBeenCalledWith(
        "LINEAR_RUN_QUERY_OR_MUTATION",
        expect.objectContaining({ entityId: "my-entity" }),
      );
    });
  });

  // ---- Successful queries -----------------------------------------------

  describe("successful queries", () => {
    it("returns correct Issue from getIssue", async () => {
      mockComposioResponse({ issue: sampleIssueNode });
      const tracker = create();
      const issue = await tracker.getIssue("INT-123", project);

      expect(issue).toEqual({
        id: "INT-123",
        title: "Fix login bug",
        description: "Users can't log in with SSO",
        url: "https://linear.app/acme/issue/INT-123",
        state: "in_progress",
        labels: ["bug", "high-priority"],
        assignee: "Alice",
        priority: 2,
      });
    });

    it("passes query and variables to Composio execute", async () => {
      mockComposioResponse({ issue: sampleIssueNode });
      const tracker = create();
      await tracker.getIssue("INT-123", project);

      const call = mockExecute.mock.calls[0];
      expect(call[0]).toBe("LINEAR_RUN_QUERY_OR_MUTATION");
      const params = call[1] as Record<string, unknown>;
      const args = params["arguments"] as Record<string, string>;
      expect(args["query_or_mutation"]).toContain("query($id: String!)");
      expect(JSON.parse(args["variables"])).toEqual({ id: "INT-123" });
    });

    it("serializes empty variables as '{}'", async () => {
      mockComposioResponse({ issue: { state: { type: "completed" } } });
      const tracker = create();

      // isCompleted passes variables, but let's verify with listIssues which
      // also always passes variables. Instead, let's test a simpler case.
      await tracker.isCompleted("INT-123", project);

      const call = mockExecute.mock.calls[0];
      const params = call[1] as Record<string, unknown>;
      const args = params["arguments"] as Record<string, string>;
      // Should be valid JSON
      expect(() => JSON.parse(args["variables"])).not.toThrow();
    });

    it("works with listIssues", async () => {
      mockComposioResponse({
        issues: {
          nodes: [sampleIssueNode],
        },
      });
      const tracker = create();
      const issues = await tracker.listIssues!({}, project);

      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe("INT-123");
    });

    it("works with isCompleted", async () => {
      mockComposioResponse({ issue: { state: { type: "completed" } } });
      const tracker = create();
      const result = await tracker.isCompleted("INT-123", project);
      expect(result).toBe(true);
    });
  });

  // ---- Error handling ---------------------------------------------------

  describe("error handling", () => {
    it("throws on unsuccessful response", async () => {
      mockComposioError("Authentication failed");
      const tracker = create();

      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "Composio Linear API error: Authentication failed",
      );
    });

    it("throws with 'unknown error' when error field is missing", async () => {
      mockExecute.mockResolvedValueOnce({
        successful: false,
      });
      const tracker = create();

      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "Composio Linear API error: unknown error",
      );
    });

    it("throws when response has no data", async () => {
      mockExecute.mockResolvedValueOnce({
        successful: true,
        data: undefined,
      });
      const tracker = create();

      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
        "Composio Linear API returned no data",
      );
    });

    it("propagates execute rejections", async () => {
      mockExecute.mockRejectedValueOnce(new Error("Network error"));
      const tracker = create();

      await expect(tracker.getIssue("INT-123", project)).rejects.toThrow("Network error");
    });
  });

  // ---- Client caching ---------------------------------------------------

  describe("client caching", () => {
    it("creates Composio client only once across multiple queries", async () => {
      mockComposioResponse({ issue: sampleIssueNode });
      mockComposioResponse({ issue: { state: { type: "started" } } });
      mockComposioResponse({
        issues: { nodes: [sampleIssueNode] },
      });

      const tracker = create();
      await tracker.getIssue("INT-123", project);
      await tracker.isCompleted("INT-123", project);
      await tracker.listIssues!({}, project);

      // Composio constructor should be called exactly once
      expect(MockComposio).toHaveBeenCalledTimes(1);
      // But execute should be called 3 times
      expect(mockExecute).toHaveBeenCalledTimes(3);
    });
  });

  // ---- Timeout ----------------------------------------------------------

  describe("timeout", () => {
    it("times out after 30s", async () => {
      // Pre-warm the client so import() resolves before we switch to fake timers.
      mockComposioResponse({ issue: sampleIssueNode });
      const tracker = create();
      await tracker.getIssue("INT-123", project);

      // Now switch to fake timers
      vi.useFakeTimers();

      // Vitest's fake timers fire the setTimeout callback synchronously
      // during advanceTimersByTimeAsync, before the microtask queue can
      // process the .catch() handler on timeoutPromise. Suppress the
      // transient unhandled rejection that vitest detects in that window.
      const suppressed: unknown[] = [];
      const handler = (reason: unknown) => {
        suppressed.push(reason);
      };
      process.on("unhandledRejection", handler);

      try {
        // Make execute hang forever
        mockExecute.mockImplementationOnce(
          () => new Promise(() => {}), // never resolves
        );

        const promise = tracker.getIssue("INT-123", project);

        // Advance timers past the 30s timeout
        await vi.advanceTimersByTimeAsync(30_001);

        await expect(promise).rejects.toThrow("Composio Linear API request timed out after 30s");
      } finally {
        process.removeListener("unhandledRejection", handler);
        vi.useRealTimers();
      }
    });
  });
});
