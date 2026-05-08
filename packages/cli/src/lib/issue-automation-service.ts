import {
  createCorrelationId,
  createProjectObserver,
  getIssueAutomationSettings,
  loadConfig,
  pollIssueAutomationProject,
  type OrchestratorConfig,
  type ProjectObserver,
  type Tracker,
} from "@aoagents/ao-core";
import { getPluginRegistry, getSessionManager } from "./create-session-manager.js";

interface AutomationLoop {
  stop: () => void;
}

const active = new Map<string, AutomationLoop>();

function reportIssueAutomationError(
  observer: ProjectObserver,
  projectId: string,
  error: unknown,
): void {
  observer.setHealth({
    surface: "issue-automation.poll",
    status: "warn",
    projectId,
    correlationId: createCorrelationId("issue-automation"),
    reason: "Issue automation poll failed",
    details: {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    },
  });
}

async function pollProject(config: OrchestratorConfig, projectId: string): Promise<void> {
  const project = config.projects[projectId];
  if (!project?.issueAutomation?.enabled || project.tracker?.plugin !== "github") return;

  const registry = await getPluginRegistry(config);
  const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
  if (!tracker) return;

  const sessionManager = await getSessionManager(config);
  await pollIssueAutomationProject({ projectId, project, tracker, sessionManager });
}

export async function startIssueAutomationWorkers(config: OrchestratorConfig): Promise<string[]> {
  const observer = createProjectObserver(config, "issue-automation");
  const started: string[] = [];

  for (const [projectId, project] of Object.entries(config.projects)) {
    if (!project.issueAutomation?.enabled || project.tracker?.plugin !== "github") continue;
    if (active.has(projectId)) continue;

    const settings = getIssueAutomationSettings(project.issueAutomation);
    const run = async (): Promise<void> => {
      try {
        const currentConfig = loadConfig(config.configPath);
        await pollProject(currentConfig, projectId);
      } catch (error) {
        reportIssueAutomationError(observer, projectId, error);
      }
    };

    void run();
    const timer = setInterval(() => void run(), settings.intervalSeconds * 1000);
    timer.unref?.();
    active.set(projectId, {
      stop: () => clearInterval(timer),
    });
    started.push(projectId);
  }

  return started;
}

export function stopIssueAutomationWorkers(): void {
  for (const [projectId, loop] of active) {
    loop.stop();
    active.delete(projectId);
  }
}
