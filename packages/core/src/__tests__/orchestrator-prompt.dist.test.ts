import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { OrchestratorConfig } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "../..");
const distModuleUrl = pathToFileURL(resolve(packageRoot, "dist/orchestrator-prompt.js")).href;
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

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

describe("generateOrchestratorPrompt dist smoke test", () => {
  it("imports the built artifact and loads the bundled markdown template at runtime", async () => {
    execFileSync(pnpmCommand, ["build"], {
      cwd: packageRoot,
      stdio: "pipe",
    });

    const { generateOrchestratorPrompt } = await import(`${distModuleUrl}?t=${Date.now()}`);
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: {
        ...config.projects["my-app"]!,
        orchestratorRules: "First block\n\n\nSecond block",
      },
    });

    expect(prompt).toContain("# My App Orchestrator");
    expect(prompt).toContain("ao session ls -p my-app");
    expect(prompt).toContain("First block\n\n\nSecond block");
  }, 30000);
});
