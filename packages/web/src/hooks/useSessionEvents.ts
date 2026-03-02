"use client";

import { useEffect, useReducer } from "react";
import type { DashboardSession, SSESessionEntry, SSESnapshotEvent, SSEDiffEvent } from "@/lib/types";

type Action =
  | { type: "reset"; sessions: DashboardSession[] }
  | { type: "snapshot"; patches: SSESnapshotEvent["sessions"] }
  | { type: "diff"; updated: SSEDiffEvent["updated"]; removed: SSEDiffEvent["removed"] };

/** Merge SSE fields into an existing session, preserving referential identity when unchanged. */
function applyPatch(
  session: DashboardSession,
  patch: SSESessionEntry,
): { session: DashboardSession; changed: boolean } {
  if (
    session.status === patch.status &&
    session.activity === patch.activity &&
    session.lastActivityAt === patch.lastActivityAt
  ) {
    return { session, changed: false };
  }
  return {
    session: { ...session, status: patch.status, activity: patch.activity, lastActivityAt: patch.lastActivityAt },
    changed: true,
  };
}

/** Create a minimal DashboardSession stub from an SSE entry (for newly discovered sessions). */
function stubSession(entry: SSESessionEntry): DashboardSession {
  return {
    id: entry.id,
    projectId: "",
    status: entry.status,
    activity: entry.activity,
    branch: null,
    issueId: null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: null,
    summary: null,
    summaryIsFallback: false,
    createdAt: entry.lastActivityAt,
    lastActivityAt: entry.lastActivityAt,
    pr: null,
    metadata: {},
  };
}

function reducer(state: DashboardSession[], action: Action): DashboardSession[] {
  switch (action.type) {
    case "reset":
      return action.sessions;
    case "snapshot": {
      const patchMap = new Map(action.patches.map((p) => [p.id, p]));
      let changed = false;
      const next = state.map((s) => {
        const patch = patchMap.get(s.id);
        if (!patch) return s;
        const result = applyPatch(s, patch);
        if (result.changed) changed = true;
        return result.session;
      });
      return changed ? next : state;
    }
    case "diff": {
      const { updated, removed } = action;
      if (updated.length === 0 && removed.length === 0) return state;

      const updateMap = new Map(updated.map((u) => [u.id, u]));
      const removedSet = new Set(removed);
      let changed = false;

      const next: DashboardSession[] = [];
      for (const s of state) {
        if (removedSet.has(s.id)) {
          changed = true;
          continue;
        }
        const patch = updateMap.get(s.id);
        if (patch) {
          const result = applyPatch(s, patch);
          if (result.changed) changed = true;
          next.push(result.session);
          updateMap.delete(s.id);
        } else {
          next.push(s);
        }
      }

      // Remaining entries in updateMap are newly added sessions.
      // The next full page load (SSR) will provide complete data.
      for (const entry of updateMap.values()) {
        changed = true;
        next.push(stubSession(entry));
      }

      return changed ? next : state;
    }
  }
}

export function useSessionEvents(initialSessions: DashboardSession[]): DashboardSession[] {
  const [sessions, dispatch] = useReducer(reducer, initialSessions);

  // Reset state when server-rendered props change (e.g. full page refresh)
  useEffect(() => {
    dispatch({ type: "reset", sessions: initialSessions });
  }, [initialSessions]);

  useEffect(() => {
    const es = new EventSource("/api/events");

    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as { type: string };
        if (data.type === "snapshot") {
          const snapshot = data as SSESnapshotEvent;
          dispatch({ type: "snapshot", patches: snapshot.sessions });
        } else if (data.type === "diff") {
          const diff = data as SSEDiffEvent;
          dispatch({ type: "diff", updated: diff.updated, removed: diff.removed });
        }
      } catch {
        // Ignore malformed messages
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do here
    };

    return () => {
      es.close();
    };
  }, []);

  return sessions;
}
