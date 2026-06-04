import { describe, expect, it } from "vitest";
import {
  buildClaudeCodeReviewArgs,
  parseReviewerOutput,
  resolveCodeReviewRunner,
  runClaudeCodeReview,
  runCodexCodeReview,
  SUPPORTED_REVIEW_AGENTS,
} from "../code-review-manager.js";
import type { OrchestratorConfig, ProjectConfig, ReviewConfig } from "../types.js";

function makeConfig(overrides: {
  defaultAgent?: string;
  review?: ReviewConfig;
  projectReview?: ReviewConfig;
}): { config: OrchestratorConfig; project: ProjectConfig } {
  const project: ProjectConfig = {
    name: "App",
    path: "/tmp/app",
    defaultBranch: "main",
    sessionPrefix: "app",
    ...(overrides.projectReview ? { review: overrides.projectReview } : {}),
  };

  const config: OrchestratorConfig = {
    configPath: "/tmp/ao/agent-orchestrator.yaml",
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: overrides.defaultAgent ?? "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects: { app: project },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
    ...(overrides.review ? { review: overrides.review } : {}),
  };

  return { config, project };
}

describe("resolveCodeReviewRunner precedence", () => {
  it("uses the explicit --command flag above everything else", () => {
    const { config, project } = makeConfig({
      defaultAgent: "claude-code",
      review: { agent: "codex" },
      projectReview: { agent: "codex" },
    });
    const runner = resolveCodeReviewRunner({ config, project, command: "echo hi" });
    // Shell-command runners are fresh closures, distinct from the agent adapters.
    expect(runner).not.toBe(runClaudeCodeReview);
    expect(runner).not.toBe(runCodexCodeReview);
  });

  it("prefers the per-project review config over the global review config", () => {
    const { config, project } = makeConfig({
      defaultAgent: "claude-code",
      review: { agent: "claude-code" },
      projectReview: { agent: "codex" },
    });
    expect(resolveCodeReviewRunner({ config, project })).toBe(runCodexCodeReview);
  });

  it("prefers the global review config over the worker-agent fallback", () => {
    const { config, project } = makeConfig({
      defaultAgent: "claude-code",
      review: { agent: "codex" },
    });
    expect(resolveCodeReviewRunner({ config, project })).toBe(runCodexCodeReview);
  });

  it("falls back to the worker agent when it has a known reviewer adapter", () => {
    const { config, project } = makeConfig({ defaultAgent: "claude-code" });
    expect(resolveCodeReviewRunner({ config, project })).toBe(runClaudeCodeReview);
  });

  it("falls back to Codex when the worker agent has no reviewer adapter", () => {
    const { config, project } = makeConfig({ defaultAgent: "aider" });
    expect(resolveCodeReviewRunner({ config, project })).toBe(runCodexCodeReview);
  });

  it("preserves Codex behavior when the worker agent is already codex", () => {
    const { config, project } = makeConfig({ defaultAgent: "codex" });
    expect(resolveCodeReviewRunner({ config, project })).toBe(runCodexCodeReview);
  });

  it("resolves review.command to a shell runner", () => {
    const { config, project } = makeConfig({ review: { command: "echo hi" } });
    const runner = resolveCodeReviewRunner({ config, project });
    expect(runner).not.toBe(runClaudeCodeReview);
    expect(runner).not.toBe(runCodexCodeReview);
  });

  it("throws a clear error for an unsupported review.agent", () => {
    const { config, project } = makeConfig({ review: { agent: " collaborator" } });
    expect(() => resolveCodeReviewRunner({ config, project })).toThrowError(
      new RegExp(`Unsupported review.agent.*${SUPPORTED_REVIEW_AGENTS.join(", ")}`),
    );
  });

  it("throws for an unsupported per-project review.agent", () => {
    const { config, project } = makeConfig({ projectReview: { agent: "nope" } });
    expect(() => resolveCodeReviewRunner({ config, project })).toThrow(/Unsupported review\.agent/);
  });
});

describe("buildClaudeCodeReviewArgs", () => {
  it("builds the expected read-only argv with the prompt", () => {
    expect(buildClaudeCodeReviewArgs("REVIEW PROMPT")).toEqual([
      "-p",
      "REVIEW PROMPT",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "text",
    ]);
  });
});

describe("parseReviewerOutput (claude-code style responses)", () => {
  const findings = [
    {
      severity: "error" as const,
      title: "Null deref",
      body: "`user` may be undefined.",
      filePath: "src/app.ts",
      startLine: 10,
      endLine: 12,
      confidence: 0.9,
    },
  ];

  it("round-trips a plain JSON object response", () => {
    const raw = JSON.stringify({ findings });
    const parsed = parseReviewerOutput(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      severity: "error",
      title: "Null deref",
      filePath: "src/app.ts",
      startLine: 10,
      endLine: 12,
    });
  });

  it("round-trips a markdown-fenced JSON response", () => {
    const raw = ["Here is my review:", "```json", JSON.stringify({ findings }), "```"].join("\n");
    const parsed = parseReviewerOutput(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.title).toBe("Null deref");
  });

  it("treats an empty findings array as no findings", () => {
    expect(parseReviewerOutput('{"findings":[]}')).toEqual([]);
  });
});
