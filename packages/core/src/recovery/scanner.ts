import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionId, OrchestratorConfig, ProjectConfig } from "../types.js";
import { listMetadata, readMetadataRaw } from "../metadata.js";
import { getProjectSessionsDir, getProjectDir, getAoBaseDir } from "../paths.js";

export interface ScannedSession {
  sessionId: SessionId;
  projectId: string;
  project: ProjectConfig;
  sessionsDir: string;
  rawMetadata: Record<string, string>;
}

export function scanAllSessions(
  config: OrchestratorConfig,
  projectIdFilter?: string,
): ScannedSession[] {
  const results: ScannedSession[] = [];

  for (const [projectKey, project] of Object.entries(config.projects)) {
    if (projectIdFilter && projectKey !== projectIdFilter) continue;

    const sessionsDir = getProjectSessionsDir(projectKey);
    if (!existsSync(sessionsDir)) continue;

    for (const file of listMetadata(sessionsDir)) {
      const rawMetadata = readMetadataRaw(sessionsDir, file);
      if (!rawMetadata) continue;

      results.push({
        sessionId: file,
        projectId: projectKey,
        project,
        sessionsDir,
        rawMetadata,
      });
    }
  }

  return results;
}

export function getRecoveryLogPath(_configPath: string, projectId?: string): string {
  if (projectId) {
    return join(getProjectDir(projectId), "recovery.log");
  }
  // Fallback: store at the AO base dir level (not under projects/)
  return join(getAoBaseDir(), "recovery.log");
}
