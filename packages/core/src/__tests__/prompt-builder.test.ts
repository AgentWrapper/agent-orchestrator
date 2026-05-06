import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  buildPrompt,
  BASE_AGENT_PROMPT,
  BASE_AGENT_PROMPT_NO_REPO,
} from "../prompt-builder.js";
import type { ProjectConfig } from "../types.js";

let tmpDir: string;
let project: ProjectConfig;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-prompt-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  project = {
    name: "Test App",
    repo: "org/test-app",
    path: tmpDir,
    defaultBranch: "main",
    sessionPrefix: "test",
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function combinePrompt({
  systemPrompt,
  taskPrompt,
}: {
  systemPrompt: string;
  taskPrompt?: string;
}): string {
  return taskPrompt ? `${systemPrompt}\n\n${taskPrompt}` : systemPrompt;
}

describe("buildPrompt split output", () => {
  it("splits persistent instructions from task-specific text", () => {
    project.agentRules = "Always run pnpm test before pushing.";

    const { systemPrompt, taskPrompt } = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      issueContext: "## Linear Issue INT-1343\nTitle: Layered Prompt System",
      userPrompt: "Focus on the API layer only.",
    });

    expect(systemPrompt).toContain(BASE_AGENT_PROMPT);
    expect(systemPrompt).toContain("## Project Context");
    expect(systemPrompt).toContain("## Project Rules");
    expect(systemPrompt).toContain("## Task");
    expect(systemPrompt).toContain("## Issue Details");
    expect(systemPrompt).not.toContain("## Additional Instructions");

    expect(taskPrompt).toContain("Focus on the API layer only.");
    expect(taskPrompt).not.toContain("Work on issue: INT-1343");
    expect(taskPrompt).not.toContain("Layered Prompt System");
  });

  it("omits taskPrompt for bare spawns", () => {
    const { taskPrompt } = buildPrompt({
      project,
      projectId: "test-app",
    });

    expect(taskPrompt).toBeUndefined();
  });
});

describe("buildPrompt", () => {
  it("includes base prompt on bare spawns", () => {
    const { systemPrompt, taskPrompt } = buildPrompt({ project, projectId: "test-app" });
    expect(systemPrompt).toContain(BASE_AGENT_PROMPT);
    expect(systemPrompt).toContain("## Project Context");
    expect(systemPrompt).toContain("Project: Test App");
    expect(taskPrompt).toBeUndefined();
  });

  it("includes base prompt when issue is provided", () => {
    const { systemPrompt, taskPrompt } = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(systemPrompt).toContain(BASE_AGENT_PROMPT);
    expect(systemPrompt).toContain("Work on issue: INT-1343");
    expect(taskPrompt).toBe("Work on issue: INT-1343");
  });

  it("includes project context", () => {
    const { systemPrompt } = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(systemPrompt).toContain("Test App");
    expect(systemPrompt).toContain("org/test-app");
    expect(systemPrompt).toContain("main");
  });

  it("uses trimmed base prompt when repo is not configured", () => {
    const noRepoProject = { ...project, repo: undefined };
    const { systemPrompt } = buildPrompt({ project: noRepoProject, projectId: "test-app" });
    expect(systemPrompt).toContain(BASE_AGENT_PROMPT_NO_REPO);
    expect(systemPrompt).not.toContain(BASE_AGENT_PROMPT);
    expect(systemPrompt).not.toContain("create a PR");
    expect(systemPrompt).not.toContain("PR Best Practices");
    expect(systemPrompt).not.toContain("Repository:");
  });

  it("includes issue ID in task section", () => {
    const { systemPrompt, taskPrompt } = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(systemPrompt).toContain("Work on issue: INT-1343");
    expect(systemPrompt).toContain("feat/INT-1343");
    expect(taskPrompt).toBe("Work on issue: INT-1343");
  });

  it("includes issue context when provided", () => {
    const { systemPrompt, taskPrompt } = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      issueContext: "## Linear Issue INT-1343\nTitle: Layered Prompt System\nPriority: High",
    });
    expect(systemPrompt).toContain("## Issue Details");
    expect(systemPrompt).toContain("Layered Prompt System");
    expect(systemPrompt).toContain("Priority: High");
    expect(taskPrompt).toBe("Work on issue: INT-1343");
    expect(taskPrompt).not.toContain("Layered Prompt System");
  });

  it("includes inline agentRules", () => {
    project.agentRules = "Always run pnpm test before pushing.";
    const { systemPrompt } = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(systemPrompt).toContain("## Project Rules");
    expect(systemPrompt).toContain("Always run pnpm test before pushing.");
  });

  it("reads agentRulesFile content", () => {
    const rulesPath = join(tmpDir, "agent-rules.md");
    writeFileSync(rulesPath, "Use conventional commits.\nNo force pushes.");
    project.agentRulesFile = "agent-rules.md";

    const { systemPrompt } = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(systemPrompt).toContain("Use conventional commits.");
    expect(systemPrompt).toContain("No force pushes.");
  });

  it("includes both agentRules and agentRulesFile", () => {
    project.agentRules = "Inline rule.";
    const rulesPath = join(tmpDir, "rules.txt");
    writeFileSync(rulesPath, "File rule.");
    project.agentRulesFile = "rules.txt";

    const { systemPrompt } = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(systemPrompt).toContain("Inline rule.");
    expect(systemPrompt).toContain("File rule.");
  });

  it("handles missing agentRulesFile gracefully", () => {
    project.agentRulesFile = "nonexistent-rules.md";

    const { systemPrompt } = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(systemPrompt).not.toContain("## Project Rules");
  });

  it("appends userPrompt last", () => {
    project.agentRules = "Project rule.";
    const prompt = combinePrompt(
      buildPrompt({
        project,
        projectId: "test-app",
        issueId: "INT-1343",
        userPrompt: "Focus on the API layer only.",
      }),
    );

    const rulesIdx = prompt.indexOf("Project rule.");
    const userIdx = prompt.indexOf("Focus on the API layer only.");
    expect(rulesIdx).toBeLessThan(userIdx);
  });

  it("builds prompt from rules alone (no issue)", () => {
    project.agentRules = "Always lint before committing.";
    const prompt = combinePrompt(
      buildPrompt({
        project,
        projectId: "test-app",
      }),
    );
    expect(prompt).toContain(BASE_AGENT_PROMPT);
    expect(prompt).toContain("Always lint before committing.");
  });

  it("builds prompt from userPrompt alone (no issue, no rules)", () => {
    const { systemPrompt, taskPrompt } = buildPrompt({
      project,
      projectId: "test-app",
      userPrompt: "Focus on the API layer only.",
    });
    expect(systemPrompt).toContain(BASE_AGENT_PROMPT);
    expect(taskPrompt).toContain("Focus on the API layer only.");
  });

  it("includes tracker info in context", () => {
    project.tracker = { plugin: "linear" };
    const { systemPrompt } = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
    });
    expect(systemPrompt).toContain("Tracker: linear");
  });

  it("uses project name in context", () => {
    const { systemPrompt } = buildPrompt({
      project,
      projectId: "my-project",
      issueId: "INT-100",
    });
    expect(systemPrompt).toContain("Project: Test App");
  });

  it("includes reaction hints for auto send-to-agent reactions", () => {
    project.reactions = {
      "ci-failed": { auto: true, action: "send-to-agent" },
      "approved-and-green": { auto: false, action: "notify" },
    };
    const { systemPrompt } = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
    });
    expect(systemPrompt).toContain("ci-failed");
    expect(systemPrompt).not.toContain("approved-and-green");
  });
});

describe("BASE_AGENT_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof BASE_AGENT_PROMPT).toBe("string");
    expect(BASE_AGENT_PROMPT.length).toBeGreaterThan(100);
  });

  it("covers key topics", () => {
    expect(BASE_AGENT_PROMPT).toContain("Session Lifecycle");
    expect(BASE_AGENT_PROMPT).toContain("Git Workflow");
    expect(BASE_AGENT_PROMPT).toContain("PR Best Practices");
    expect(BASE_AGENT_PROMPT).toContain("ao session claim-pr");
  });
});
