/**
 * Portfolio session service — lightweight cross-project session aggregation.
 *
 * Uses async I/O to avoid blocking the Node.js event loop in web server contexts.
 * Reads session metadata files directly without constructing SessionManagers.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isOrchestratorSession, type CanonicalSessionLifecycle, type PortfolioProject, type PortfolioSession, type RuntimeHandle, type Session, type SessionMetadata } from "./types.js";
import { getProjectSessionsDir } from "./paths.js";
import { deriveLegacyStatus } from "./lifecycle-state.js";
import { flattenToStringRecord } from "./utils/metadata-flatten.js";
import { sessionFromMetadata } from "./utils/session-from-metadata.js";

const JSON_EXTENSION = ".json";

function tryParseJson<T>(value: string): T | undefined {
  try { return JSON.parse(value) as T; } catch { return undefined; }
}

const DEFAULT_PER_PROJECT_TIMEOUT_MS = 3_000;
const VALID_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

export async function listPortfolioSessions(
  portfolio: PortfolioProject[],
  opts?: { perProjectTimeoutMs?: number },
): Promise<PortfolioSession[]> {
  const timeout = opts?.perProjectTimeoutMs ?? DEFAULT_PER_PROJECT_TIMEOUT_MS;
  const results: PortfolioSession[] = [];

  for (const project of portfolio) {
    if (!project.enabled || project.resolveError) continue;

    try {
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const projectResults = await Promise.race([
        loadProjectSessions(project).finally(() => {
          if (timerId !== undefined) clearTimeout(timerId);
        }),
        new Promise<PortfolioSession[]>((resolve) => {
          timerId = setTimeout(() => resolve([]), timeout);
        }),
      ]);
      results.push(...projectResults);
    } catch {
      // Skip projects whose session dirs can't be read
    }
  }

  return results;
}

async function loadProjectSessions(project: PortfolioProject): Promise<PortfolioSession[]> {
  const results: PortfolioSession[] = [];
  const sessionsDir = getProjectSessionsDir(project.id);

  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return results; // Dir doesn't exist
  }

  for (const name of entries) {
    if (!name.endsWith(JSON_EXTENSION)) continue;
    if (name === "archive" || name.startsWith(".")) continue;
    const sessionId = name.slice(0, -JSON_EXTENSION.length);
    if (!VALID_SESSION_ID.test(sessionId)) continue;

    try {
      const filePath = join(sessionsDir, name);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;

      const content = await readFile(filePath, "utf-8");
      const raw = flattenToStringRecord(JSON.parse(content) as Record<string, unknown>);

      // Exclude orchestrator sessions from portfolio listings
      if (isOrchestratorSession({ id: sessionId, metadata: raw })) continue;

      const metadata = rawToMetadata(raw);
      const session = metadataToSession(sessionId, project, metadata);
      results.push({ session, project });
    } catch {
      continue;
    }
  }

  return results;
}

function rawToMetadata(raw: Record<string, string>): SessionMetadata {
  const lifecycle = raw["lifecycle"] ? tryParseJson<CanonicalSessionLifecycle>(raw["lifecycle"]) : undefined;
  const storedStatus = raw["status"];
  const status = (lifecycle ? deriveLegacyStatus(lifecycle) : undefined) ?? storedStatus ?? "unknown";

  return {
    worktree: raw["worktree"] ?? "",
    branch: raw["branch"] ?? "",
    status,
    tmuxName: raw["tmuxName"],
    issue: raw["issue"],
    pr: raw["pr"],
    summary: raw["summary"],
    project: raw["project"],
    agent: raw["agent"],
    createdAt: raw["createdAt"],
    runtimeHandle: raw["runtimeHandle"] ? tryParseJson<RuntimeHandle>(raw["runtimeHandle"]) : undefined,
    restoredAt: raw["restoredAt"],
    role: raw["role"],
    lifecycle,
  };
}

function metadataToRecord(metadata: SessionMetadata): Record<string, string> {
  const record: Record<string, string> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      record[key] = value;
    } else if (typeof value === "object" && value !== null) {
      record[key] = JSON.stringify(value);
    } else if (typeof value === "number") {
      record[key] = String(value);
    }
  }

  return record;
}

/** Convert raw metadata to a Session object (lightweight, no plugin init) */
function metadataToSession(sessionId: string, project: PortfolioProject, metadata: SessionMetadata): Session {
  // Use the most recent timestamp available as lastActivityAt
  const timestamps = [metadata.createdAt, metadata.restoredAt].filter(
    (timestamp): timestamp is string => typeof timestamp === "string" && timestamp.length > 0,
  );
  const lastActivity = timestamps.length > 0
    ? new Date(Math.max(...timestamps.map((timestamp) => new Date(timestamp).getTime())))
    : new Date();

  return sessionFromMetadata(sessionId, metadataToRecord(metadata), {
    projectId: project.id,
    status: (metadata.status as Session["status"]) || "spawning",
    activity: null,
    runtimeHandle: metadata.runtimeHandle ?? null,
    createdAt: metadata.createdAt ? new Date(metadata.createdAt) : new Date(),
    lastActivityAt: lastActivity,
    restoredAt: metadata.restoredAt ? new Date(metadata.restoredAt) : undefined,
  });
}

export async function getPortfolioSessionCounts(portfolio: PortfolioProject[]): Promise<Record<string, { total: number; active: number }>> {
  const counts: Record<string, { total: number; active: number }> = {};
  const TERMINAL = new Set(["killed", "terminated", "done", "cleanup", "errored", "merged"]);

  for (const project of portfolio) {
    if (!project.enabled || project.resolveError) {
      counts[project.id] = { total: 0, active: 0 };
      continue;
    }

    try {
      const sessionsDir = getProjectSessionsDir(project.id);
      let entries: string[];
      try {
        entries = await readdir(sessionsDir);
      } catch {
        counts[project.id] = { total: 0, active: 0 };
        continue;
      }

      let total = 0;
      let active = 0;

      for (const name of entries) {
        if (!name.endsWith(JSON_EXTENSION)) continue;
        if (name === "archive" || name.startsWith(".")) continue;
        const sessionId = name.slice(0, -JSON_EXTENSION.length);
        if (!VALID_SESSION_ID.test(sessionId)) continue;

        try {
          const filePath = join(sessionsDir, name);
          const fileStat = await stat(filePath);
          if (!fileStat.isFile()) continue;

          const content = await readFile(filePath, "utf-8");
          const raw = flattenToStringRecord(JSON.parse(content) as Record<string, unknown>);

          // Exclude orchestrator sessions from portfolio counts
          if (isOrchestratorSession({ id: sessionId, metadata: raw })) continue;

          total++;
          // Derive status from lifecycle when not stored (post-migration JSON)
          let sessionStatus = raw["status"];
          if (!sessionStatus && raw["lifecycle"]) {
            const lifecycle = tryParseJson<CanonicalSessionLifecycle>(raw["lifecycle"]);
            if (lifecycle) sessionStatus = deriveLegacyStatus(lifecycle);
          }
          if (!TERMINAL.has(sessionStatus ?? "")) active++;
        } catch {
          continue;
        }
      }

      counts[project.id] = { total, active };
    } catch {
      counts[project.id] = { total: 0, active: 0 };
    }
  }

  return counts;
}
