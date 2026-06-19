/**
 * Cost Parser
 *
 * Parses agent output to extract token usage and cost information.
 * Supports multiple agent CLIs with different output formats.
 */

export interface ParsedCostMetrics {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  confidence: "high" | "medium" | "low";
}

export interface CostParseResult {
  metrics: ParsedCostMetrics | null;
  rawText: string;
  parseErrors: string[];
}

/**
 * Parse cost metrics from agent output text
 */
export function parseCostFromOutput(output: string, agentType: string): CostParseResult {
  const parseErrors: string[] = [];
  let metrics: ParsedCostMetrics | null = null;

  try {
    switch (agentType) {
      case "claude-code":
        metrics = parseClaudeCodeCost(output);
        break;
      case "codex":
        metrics = parseCodexCost(output);
        break;
      case "aider":
        metrics = parseAiderCost(output);
        break;
      case "cursor":
        metrics = parseCursorCost(output);
        break;
      default:
        // Try generic parsing
        metrics = parseGenericCost(output);
    }
  } catch (error) {
    parseErrors.push(`Parse error: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    metrics,
    rawText: output,
    parseErrors,
  };
}

/**
 * Parse Claude Code cost output
 * Expected format: "Tokens: 1234 (input: 567, output: 667) | Cost: $0.0123"
 */
function parseClaudeCodeCost(output: string): ParsedCostMetrics | null {
  const tokenMatch = output.match(/Tokens:\s*(\d+)\s*\(input:\s*(\d+),\s*output:\s*(\d+)\)/);
  const costMatch = output.match(/Cost:\s*\$?([\d.]+)/);
  const modelMatch = output.match(/Model:\s*(\S+)/);

  if (!tokenMatch) return null;

  const inputTokens = parseInt(tokenMatch[2], 10);
  const outputTokens = parseInt(tokenMatch[3], 10);
  const totalTokens = parseInt(tokenMatch[1], 10);
  const costUsd = costMatch
    ? parseFloat(costMatch[1])
    : estimateCost(inputTokens, outputTokens, "claude-3-5-sonnet");
  const model = modelMatch?.[1] || "claude-3-5-sonnet";

  return {
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    confidence: costMatch ? "high" : "medium",
  };
}

/**
 * Parse Codex cost output
 * Expected format: "Used 1234 tokens (567 in, 667 out) - $0.0123"
 */
function parseCodexCost(output: string): ParsedCostMetrics | null {
  const tokenMatch = output.match(/Used\s*(\d+)\s*tokens\s*\((\d+)\s*in,\s*(\d+)\s*out\)/);
  const costMatch = output.match(/\$\s*([\d.]+)/);
  const modelMatch = output.match(/Model:\s*(\S+)/);

  if (!tokenMatch) return null;

  const totalTokens = parseInt(tokenMatch[1], 10);
  const inputTokens = parseInt(tokenMatch[2], 10);
  const outputTokens = parseInt(tokenMatch[3], 10);
  const costUsd = costMatch
    ? parseFloat(costMatch[1])
    : estimateCost(inputTokens, outputTokens, "gpt-4");
  const model = modelMatch?.[1] || "gpt-4";

  return {
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    confidence: costMatch ? "high" : "medium",
  };
}

/**
 * Parse Aider cost output
 * Aider doesn't typically output cost, so we estimate from tokens
 */
function parseAiderCost(output: string): ParsedCostMetrics | null {
  const tokenMatch = output.match(/(\d+)\s*tokens/);

  if (!tokenMatch) return null;

  const totalTokens = parseInt(tokenMatch[1], 10);
  // Estimate 60/40 split for typical coding tasks
  const inputTokens = Math.floor(totalTokens * 0.6);
  const outputTokens = totalTokens - inputTokens;
  const costUsd = estimateCost(inputTokens, outputTokens, "gpt-4");

  return {
    model: "gpt-4",
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    confidence: "low",
  };
}

/**
 * Parse Cursor cost output
 * Cursor may not output cost, so we estimate
 */
function parseCursorCost(output: string): ParsedCostMetrics | null {
  const tokenMatch = output.match(/(\d+)\s*tokens/);

  if (!tokenMatch) return null;

  const totalTokens = parseInt(tokenMatch[1], 10);
  const inputTokens = Math.floor(totalTokens * 0.6);
  const outputTokens = totalTokens - inputTokens;
  const costUsd = estimateCost(inputTokens, outputTokens, "gpt-4");

  return {
    model: "gpt-4",
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    confidence: "low",
  };
}

/**
 * Generic cost parsing - tries to find any token/cost information
 */
function parseGenericCost(output: string): ParsedCostMetrics | null {
  // Look for any token pattern
  const tokenMatch = output.match(/(\d+)\s*tokens?/i);

  if (!tokenMatch) return null;

  const totalTokens = parseInt(tokenMatch[1], 10);
  const inputTokens = Math.floor(totalTokens * 0.6);
  const outputTokens = totalTokens - inputTokens;
  const costUsd = estimateCost(inputTokens, outputTokens, "gpt-4");

  return {
    model: "unknown",
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    confidence: "low",
  };
}

/**
 * Estimate cost from token counts
 * Uses approximate pricing as of 2024
 */
function estimateCost(inputTokens: number, outputTokens: number, model: string): number {
  // Pricing per 1M tokens (approximate USD)
  const pricing: Record<string, { input: number; output: number }> = {
    "claude-3-5-sonnet": { input: 3, output: 15 },
    "claude-3-opus": { input: 15, output: 75 },
    "gpt-4": { input: 30, output: 60 },
    "gpt-4-turbo": { input: 10, output: 30 },
    "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
    unknown: { input: 10, output: 30 },
  };

  const modelPricing = pricing[model] || pricing["unknown"];

  const inputCost = (inputTokens / 1_000_000) * modelPricing.input;
  const outputCost = (outputTokens / 1_000_000) * modelPricing.output;

  return inputCost + outputCost;
}

/**
 * Parse multiple cost entries from a larger output
 */
export function parseMultipleCostEntries(output: string, agentType: string): ParsedCostMetrics[] {
  const entries: ParsedCostMetrics[] = [];

  // Split by common delimiters that might separate multiple operations
  const sections = output.split(/\n\n+|\n---+\n|\n={3,}/);

  for (const section of sections) {
    const result = parseCostFromOutput(section, agentType);
    if (result.metrics) {
      entries.push(result.metrics);
    }
  }

  return entries;
}

/**
 * Aggregate multiple cost entries
 */
export function aggregateCostEntries(entries: ParsedCostMetrics[]): ParsedCostMetrics {
  if (entries.length === 0) {
    return {
      model: "unknown",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      confidence: "low",
    };
  }

  const totalInputTokens = entries.reduce((sum, e) => sum + e.inputTokens, 0);
  const totalOutputTokens = entries.reduce((sum, e) => sum + e.outputTokens, 0);
  const totalCost = entries.reduce((sum, e) => sum + e.costUsd, 0);

  // Use the most common model, or the first one
  const modelCounts = entries.reduce(
    (acc, e) => {
      acc[e.model] = (acc[e.model] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const dominantModel =
    Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";

  // Confidence is high if all entries have high confidence
  const allHighConfidence = entries.every((e) => e.confidence === "high");
  const confidence = allHighConfidence ? "high" : "medium";

  return {
    model: dominantModel,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    costUsd: totalCost,
    confidence,
  };
}
