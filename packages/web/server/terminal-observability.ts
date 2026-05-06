import {
  createProjectObserver,
  loadConfig,
  resolveProjectIdForSessionId,
  type OrchestratorConfig,
  type ProjectObserver,
} from "@aoagents/ao-core";

export function createObserverContext(surface: string): {
  config: OrchestratorConfig | undefined;
  observer: ProjectObserver | undefined;
} {
  try {
    const config = loadConfig();
    return {
      config,
      observer: createProjectObserver(config, surface),
    };
  } catch {
    return { config: undefined, observer: undefined };
  }
}

export function inferProjectId(
  config: OrchestratorConfig | undefined,
  sessionId: string,
): string | undefined {
  return config ? resolveProjectIdForSessionId(config, sessionId) : undefined;
}
