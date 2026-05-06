import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorConfig, ProjectConfig } from "../types.js";

const config: OrchestratorConfig = {
  configPath: "/tmp/agent-orchestrator.yaml",
  port: 3000,
  power: { preventIdleSleep: false },
  defaults: {
    runtime: "tmux",
    agent: "claude-code",
    workspace: "worktree",
    notifiers: ["desktop"],
  },
  projects: {
    "my-app": {
      name: "My App",
      repo: "org/my-app",
      path: "/tmp/my-app",
      defaultBranch: "main",
      sessionPrefix: "app",
    },
  },
  notifiers: {},
  notificationRouting: {
    urgent: ["desktop"],
    action: ["desktop"],
    warning: [],
    info: [],
  },
  reactions: {},
  readyThresholdMs: 300_000,
};

async function loadGenerateOrchestratorPrompt() {
  vi.resetModules();
  return (await import("../orchestrator-prompt.js")).generateOrchestratorPrompt;
}

async function loadGenerateOrchestratorPromptWithTemplate(template: string) {
  vi.resetModules();
  vi.doMock("../prompts/orchestrator.md", () => ({
    default: template,
  }));

  return (await import("../orchestrator-prompt.js")).generateOrchestratorPrompt;
}

describe("generateOrchestratorPrompt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../prompts/orchestrator.md");
    vi.resetModules();
  });

  it("requires read-only investigation from the orchestrator session", async () => {
    const generateOrchestratorPrompt = await loadGenerateOrchestratorPrompt();
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("Investigations from the orchestrator session are **read-only**");
    expect(prompt).toContain("do not edit repository files or implement fixes");
  });

  it("mandates ao send and bans raw tmux access", async () => {
    const generateOrchestratorPrompt = await loadGenerateOrchestratorPrompt();
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("Always use `ao send`");
    expect(prompt).toContain("never use raw `tmux send-keys`");
    expect(prompt).toContain("ao send --no-wait");
  });

  it("shows 'not configured' and omits repo-only guidance when repo is omitted", async () => {
    const generateOrchestratorPrompt = await loadGenerateOrchestratorPrompt();
    const noRepoProject = { ...config.projects["my-app"]!, repo: undefined };
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: noRepoProject,
    });

    expect(prompt).toContain("not configured");
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("ao batch-spawn");
    expect(prompt).not.toContain("ao session claim-pr");
    expect(prompt).not.toContain("PR state (open/merged/closed)");
    expect(prompt).toContain("No repository remote is configured.");
  });

  it("pushes implementation and PR claiming into worker sessions", async () => {
    const generateOrchestratorPrompt = await loadGenerateOrchestratorPrompt();
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("must be delegated to a **worker session**");
    expect(prompt).toContain("Never claim a PR into `app-orchestrator`");
    expect(prompt).toContain("Delegate implementation, test execution, or PR claiming");
  });

  it("expands markdown template placeholders with typed render data", async () => {
    const generateOrchestratorPrompt = await loadGenerateOrchestratorPrompt();
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("# My App Orchestrator");
    expect(prompt).toContain("- **Repository**: org/my-app");
    expect(prompt).toContain("ao session ls -p my-app");
    expect(prompt).toContain("http://localhost:3000");
  });

  it("throws when the markdown template contains an unresolved snake_case placeholder", async () => {
    const generateOrchestratorPrompt =
      await loadGenerateOrchestratorPromptWithTemplate("Hello {{missing_placeholder}}");

    expect(() =>
      generateOrchestratorPrompt({
        config,
        projectId: "my-app",
        project: config.projects["my-app"]!,
      }),
    ).toThrow("Unresolved template placeholder: missing_placeholder");
  });

  it("throws when the markdown template placeholder matches a prototype property", async () => {
    const generateOrchestratorPrompt =
      await loadGenerateOrchestratorPromptWithTemplate("Hello {{toString}}");

    expect(() =>
      generateOrchestratorPrompt({
        config,
        projectId: "my-app",
        project: config.projects["my-app"]!,
      }),
    ).toThrow("Unresolved template placeholder: toString");
  });

  it("throws when the markdown template leaves behind a malformed placeholder", async () => {
    const generateOrchestratorPrompt =
      await loadGenerateOrchestratorPromptWithTemplate("Hello {{ projectName }}");

    expect(() =>
      generateOrchestratorPrompt({
        config,
        projectId: "my-app",
        project: config.projects["my-app"]!,
      }),
    ).toThrow("Unresolved template placeholder: {{ projectName }}");
  });

  it("throws when the markdown template contains an unmatched optional-section marker", async () => {
    const generateOrchestratorPrompt =
      await loadGenerateOrchestratorPromptWithTemplate(
        "{{AUTOMATED_REACTIONS_SECTION_START}}\n{{automatedReactionsSection}}",
      );

    expect(() =>
      generateOrchestratorPrompt({
        config,
        projectId: "my-app",
        project: config.projects["my-app"]!,
      }),
    ).toThrow(
      "Malformed optional section block: expected {{AUTOMATED_REACTIONS_SECTION_START}} before {{AUTOMATED_REACTIONS_SECTION_END}}",
    );
  });

  it("throws when the markdown template nests the same optional section type", async () => {
    const generateOrchestratorPrompt =
      await loadGenerateOrchestratorPromptWithTemplate(
        "{{REPO_CONFIGURED_SECTION_START}}outer {{REPO_CONFIGURED_SECTION_START}}inner{{REPO_CONFIGURED_SECTION_END}}{{REPO_CONFIGURED_SECTION_END}}",
      );

    expect(() =>
      generateOrchestratorPrompt({
        config,
        projectId: "my-app",
        project: config.projects["my-app"]!,
      }),
    ).toThrow(
      "Nested optional section blocks are not supported: {{REPO_CONFIGURED_SECTION_START}} before {{REPO_CONFIGURED_SECTION_END}}",
    );
  });

  it("renders optional sections only when project data is present", async () => {
    const generateOrchestratorPrompt = await loadGenerateOrchestratorPrompt();
    const projectWithOptionalSections: ProjectConfig = {
      ...config.projects["my-app"]!,
      reactions: {
        ci_failed: {
          auto: true,
          action: "send-to-agent",
          retries: 2,
          escalateAfter: 3,
        },
      },
      orchestratorRules: "Escalate production incidents immediately.",
    };

    const promptWithOptionalSections = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: projectWithOptionalSections,
    });

    const promptWithoutOptionalSections = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(promptWithOptionalSections).toContain("## Automated Reactions");
    expect(promptWithOptionalSections).toContain("ci_failed");
    expect(promptWithOptionalSections).toContain("## Project-Specific Rules");
    expect(promptWithOptionalSections).toContain("Escalate production incidents immediately.");
    expect(promptWithoutOptionalSections).not.toContain("## Automated Reactions");
    expect(promptWithoutOptionalSections).not.toContain("## Project-Specific Rules");
  });

  it("preserves intentional blank lines inside project-specific rules", async () => {
    const generateOrchestratorPrompt = await loadGenerateOrchestratorPrompt();
    const projectWithSpacedRules: ProjectConfig = {
      ...config.projects["my-app"]!,
      orchestratorRules: "First block\n\n\nSecond block",
    };

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: projectWithSpacedRules,
    });

    expect(prompt).toContain("First block\n\n\nSecond block");
  });

  it("allows literal handlebars inside project-specific rules", async () => {
    const generateOrchestratorPrompt = await loadGenerateOrchestratorPrompt();
    const projectWithHandlebarsRules: ProjectConfig = {
      ...config.projects["my-app"]!,
      orchestratorRules: "Use {{example}} literally in the docs.",
    };

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: projectWithHandlebarsRules,
    });

    expect(prompt).toContain("Use {{example}} literally in the docs.");
  });
});
