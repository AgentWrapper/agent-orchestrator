import type { ProjectConfig } from "./types.js";

export type NormalizedOrchestratorSessionStrategy = "reuse" | "delete" | "ignore";

export function getOrchestratorSessionId(project: Pick<ProjectConfig, "sessionPrefix">): string {
  return `${project.sessionPrefix}-orchestrator`;
}

export function normalizeOrchestratorSessionStrategy(
  strategy: ProjectConfig["orchestratorSessionStrategy"] | undefined,
): NormalizedOrchestratorSessionStrategy {
  if (strategy === "kill-previous" || strategy === "delete-new") return "delete";
  if (strategy === "ignore-new") return "ignore";
  return strategy ?? "reuse";
}
