/**
 * Tests for cost parser
 */

import { describe, it, expect } from "vitest";
import {
  parseCostFromOutput,
  parseMultipleCostEntries,
  aggregateCostEntries,
} from "../src/cost-parser.js";

describe("Cost Parser", () => {
  describe("parseClaudeCodeCost", () => {
    it("should parse Claude Code cost output", () => {
      const output =
        "Tokens: 1234 (input: 567, output: 667) | Cost: $0.0123 | Model: claude-3-5-sonnet";
      const result = parseCostFromOutput(output, "claude-code");

      expect(result.metrics).not.toBeNull();
      expect(result.metrics?.totalTokens).toBe(1234);
      expect(result.metrics?.inputTokens).toBe(567);
      expect(result.metrics?.outputTokens).toBe(667);
      expect(result.metrics?.costUsd).toBe(0.0123);
      expect(result.metrics?.model).toBe("claude-3-5-sonnet");
      expect(result.metrics?.confidence).toBe("high");
    });

    it("should estimate cost when not provided", () => {
      const output = "Tokens: 1234 (input: 567, output: 667)";
      const result = parseCostFromOutput(output, "claude-code");

      expect(result.metrics).not.toBeNull();
      expect(result.metrics?.totalTokens).toBe(1234);
      expect(result.metrics?.costUsd).toBeGreaterThan(0);
      expect(result.metrics?.confidence).toBe("medium");
    });

    it("should return null when no token info found", () => {
      const output = "No token information here";
      const result = parseCostFromOutput(output, "claude-code");

      expect(result.metrics).toBeNull();
    });
  });

  describe("parseCodexCost", () => {
    it("should parse Codex cost output", () => {
      const output = "Used 1234 tokens (567 in, 667 out) - $0.0123 | Model: gpt-4";
      const result = parseCostFromOutput(output, "codex");

      expect(result.metrics).not.toBeNull();
      expect(result.metrics?.totalTokens).toBe(1234);
      expect(result.metrics?.inputTokens).toBe(567);
      expect(result.metrics?.outputTokens).toBe(667);
      expect(result.metrics?.costUsd).toBe(0.0123);
      expect(result.metrics?.model).toBe("gpt-4");
    });
  });

  describe("parseAiderCost", () => {
    it("should parse Aider token output and estimate cost", () => {
      const output = "Processed 1234 tokens";
      const result = parseCostFromOutput(output, "aider");

      expect(result.metrics).not.toBeNull();
      expect(result.metrics?.totalTokens).toBe(1234);
      expect(result.metrics?.costUsd).toBeGreaterThan(0);
      expect(result.metrics?.confidence).toBe("low");
    });
  });

  describe("parseCursorCost", () => {
    it("should parse Cursor token output and estimate cost", () => {
      const output = "Generated 1234 tokens";
      const result = parseCostFromOutput(output, "cursor");

      expect(result.metrics).not.toBeNull();
      expect(result.metrics?.totalTokens).toBe(1234);
      expect(result?.metrics?.costUsd).toBeGreaterThan(0);
      expect(result.metrics?.confidence).toBe("low");
    });
  });

  describe("parseGenericCost", () => {
    it("should parse generic token output", () => {
      const output = "Total: 1234 tokens";
      const result = parseCostFromOutput(output, "unknown");

      expect(result.metrics).not.toBeNull();
      expect(result.metrics?.totalTokens).toBe(1234);
    });
  });

  describe("parseMultipleCostEntries", () => {
    it("should parse multiple cost entries from output", () => {
      const output = `Tokens: 100 (input: 50, output: 50) | Cost: $0.001

---
Tokens: 200 (input: 100, output: 100) | Cost: $0.002`;

      const entries = parseMultipleCostEntries(output, "claude-code");

      expect(entries).toHaveLength(2);
      expect(entries[0].totalTokens).toBe(100);
      expect(entries[1].totalTokens).toBe(200);
    });
  });

  describe("aggregateCostEntries", () => {
    it("should aggregate multiple cost entries", () => {
      const entries = [
        {
          model: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          costUsd: 0.001,
          confidence: "high" as const,
        },
        {
          model: "claude-3-5-sonnet",
          inputTokens: 200,
          outputTokens: 100,
          totalTokens: 300,
          costUsd: 0.002,
          confidence: "high" as const,
        },
      ];

      const aggregated = aggregateCostEntries(entries);

      expect(aggregated.totalTokens).toBe(450);
      expect(aggregated.inputTokens).toBe(300);
      expect(aggregated.outputTokens).toBe(150);
      expect(aggregated.costUsd).toBe(0.003);
      expect(aggregated.model).toBe("claude-3-5-sonnet");
      expect(aggregated.confidence).toBe("high");
    });

    it("should handle empty entries array", () => {
      const aggregated = aggregateCostEntries([]);

      expect(aggregated.totalTokens).toBe(0);
      expect(aggregated.costUsd).toBe(0);
      expect(aggregated.confidence).toBe("low");
    });

    it("should determine dominant model", () => {
      const entries = [
        {
          model: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          costUsd: 0.001,
          confidence: "high" as const,
        },
        {
          model: "gpt-4",
          inputTokens: 50,
          outputTokens: 25,
          totalTokens: 75,
          costUsd: 0.001,
          confidence: "medium" as const,
        },
        {
          model: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          costUsd: 0.001,
          confidence: "high" as const,
        },
      ];

      const aggregated = aggregateCostEntries(entries);

      expect(aggregated.model).toBe("claude-3-5-sonnet");
    });
  });
});
