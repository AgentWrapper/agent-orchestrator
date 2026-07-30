import {
  CloudAPI,
  CloudWorkspaceDiff,
  CloudWorkspaceEntry,
} from "@/lib/cloud-api";

interface WorkspaceSnapshot {
  diff?: CloudWorkspaceDiff;
  rootEntries?: CloudWorkspaceEntry[];
  updatedAt: number;
}

const snapshots = new Map<string, WorkspaceSnapshot>();
const inFlight = new Map<string, Promise<void>>();

export function getWorkspaceSnapshot(sessionId: string) {
  return snapshots.get(sessionId);
}

export function removeWorkspaceSnapshots(activeSessionIds: Set<string>) {
  for (const sessionId of snapshots.keys()) {
    if (!activeSessionIds.has(sessionId)) snapshots.delete(sessionId);
  }
}

export function warmWorkspaceSession(api: CloudAPI, sessionId: string) {
  const existing = inFlight.get(sessionId);
  if (existing) return existing;
  const request = Promise.allSettled([
    api.workspaceDiff(sessionId),
    api.workspaceFiles(sessionId),
  ])
    .then(([diffResult, filesResult]) => {
      const current = snapshots.get(sessionId);
      snapshots.set(sessionId, {
        diff:
          diffResult.status === "fulfilled" ? diffResult.value : current?.diff,
        rootEntries:
          filesResult.status === "fulfilled"
            ? filesResult.value.entries
            : current?.rootEntries,
        updatedAt: Date.now(),
      });
    })
    .finally(() => {
      inFlight.delete(sessionId);
    });
  inFlight.set(sessionId, request);
  return request;
}
