import {
  CloudAPI,
  CloudWorkspaceDiff,
  CloudWorkspaceEntry,
} from "@/lib/cloud-api";

export interface WorkspaceSnapshot {
  diff?: CloudWorkspaceDiff;
  rootEntries?: CloudWorkspaceEntry[];
  diffError?: string;
  filesError?: string;
  updatedAt: number;
}

const snapshots = new Map<string, WorkspaceSnapshot>();
const inFlight = new Map<
  string,
  { request: Promise<void>; includeDiff: boolean }
>();
const listeners = new Map<string, Set<() => void>>();
const generations = new Map<string, number>();

export function getWorkspaceSnapshot(sessionId: string) {
  return snapshots.get(sessionId);
}

export function subscribeWorkspaceSnapshot(
  sessionId: string,
  listener: () => void,
) {
  const sessionListeners = listeners.get(sessionId) ?? new Set();
  sessionListeners.add(listener);
  listeners.set(sessionId, sessionListeners);
  return () => {
    sessionListeners.delete(listener);
    if (sessionListeners.size === 0) listeners.delete(sessionId);
  };
}

export function removeWorkspaceSnapshots(activeSessionIds: Set<string>) {
  const knownSessionIds = new Set([...snapshots.keys(), ...inFlight.keys()]);
  for (const sessionId of knownSessionIds) {
    if (activeSessionIds.has(sessionId)) continue;
    snapshots.delete(sessionId);
    generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1);
    notify(sessionId);
  }
}

export function warmWorkspaceSession(
  api: CloudAPI,
  orgId: string,
  sessionId: string,
  options: { includeDiff?: boolean } = {},
): Promise<void> {
  const includeDiff = options.includeDiff ?? true;
  const existing = inFlight.get(sessionId);
  if (existing) {
    if (existing.includeDiff || !includeDiff) return existing.request;
    return existing.request.then(() =>
      warmWorkspaceSession(api, orgId, sessionId, { includeDiff: true }),
    );
  }
  const generation = generations.get(sessionId) ?? 0;
  let request: Promise<void>;
  request = Promise.allSettled([
    includeDiff ? api.workspaceDiff(orgId, sessionId) : Promise.resolve(undefined),
    api.workspaceFiles(orgId, sessionId),
  ])
    .then(([diffResult, filesResult]) => {
      if ((generations.get(sessionId) ?? 0) !== generation) return;
      const current = snapshots.get(sessionId);
      snapshots.set(sessionId, {
        diff:
          diffResult.status === "fulfilled" && diffResult.value
            ? diffResult.value
            : current?.diff,
        rootEntries:
          filesResult.status === "fulfilled"
            ? filesResult.value.entries
            : current?.rootEntries,
        diffError:
          includeDiff && diffResult.status === "rejected"
            ? errorMessage(diffResult.reason, "Could not load changes.")
            : undefined,
        filesError:
          filesResult.status === "rejected"
            ? errorMessage(filesResult.reason, "Could not load files.")
            : undefined,
        updatedAt: Date.now(),
      });
      notify(sessionId);
    })
    .finally(() => {
      if (inFlight.get(sessionId)?.request === request) inFlight.delete(sessionId);
    });
  inFlight.set(sessionId, { request, includeDiff });
  return request;
}

function notify(sessionId: string) {
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
