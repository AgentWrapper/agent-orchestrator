/**
 * Fallback for `ao start`'s restore prompt when `last-stop.json` is
 * missing or malformed (issue #1743). Without this, a single regression
 * in the last-stop write pipeline silently swallows the user's
 * in-flight work.
 *
 * The fallback scans recently terminated sessions across every project
 * the running session manager can see and synthesizes a `LastStopState`
 * from any that look like they were killed by `ao stop` (canonical
 * lifecycle reason `manually_killed`) within the recent past.
 *
 * It deliberately does *not* try to be clever: it does not consult
 * `running.json`, does not infer ownership from process state, and does
 * not attempt to deduplicate against an already-restored session.
 * `sm.restore()` is the source of truth for whether a candidate is
 * actually restorable; the fallback's only job is to make sure the
 * prompt fires at all.
 */

import type { Session, SessionManager } from "@aoagents/ao-core";
import type { LastStopState } from "./running-state.js";

/**
 * How recent a `manually_killed` session must be (in ms) for the
 * fallback to surface it. 10 minutes covers the typical
 * `ao stop` → `ao update` → `ao start` flow (a few seconds of stop +
 * a minute or two of update) with generous slack for slow updates,
 * while still excluding stale sessions from days/weeks ago.
 */
export const FALLBACK_RECENT_WINDOW_MS = 10 * 60 * 1000;

function getTerminatedAtMs(session: Session): number | null {
  const ts = session.lifecycle?.session?.terminatedAt ?? null;
  if (!ts) return null;
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

/**
 * Build a synthetic `LastStopState` from sessions that:
 *   - are canonically terminated,
 *   - have reason "manually_killed",
 *   - and were terminated within `windowMs` of `now`.
 *
 * Returns null if nothing qualifies, so callers can do
 * `lastStop ?? buildFallback(...)`.
 *
 * The returned record uses the *most recent* terminatedAt as the
 * `stoppedAt` timestamp so the prompt's "stopped at <X>" string is
 * meaningful.
 */
export function buildLastStopFallback(
  sessions: Session[],
  primaryProjectId: string,
  options?: { now?: number; windowMs?: number },
): LastStopState | null {
  const now = options?.now ?? Date.now();
  const windowMs = options?.windowMs ?? FALLBACK_RECENT_WINDOW_MS;
  const cutoff = now - windowMs;

  const candidates: Array<{ session: Session; terminatedAt: number }> = [];
  for (const session of sessions) {
    const lifecycle = session.lifecycle?.session;
    if (!lifecycle) continue;
    if (lifecycle.state !== "terminated") continue;
    if (lifecycle.reason !== "manually_killed") continue;
    const terminatedAt = getTerminatedAtMs(session);
    if (terminatedAt === null) continue;
    if (terminatedAt < cutoff) continue;
    candidates.push({ session, terminatedAt });
  }

  if (candidates.length === 0) return null;

  // Group by project, with the active CLI's project surfaced via
  // `sessionIds` and everything else routed to `otherProjects` —
  // matches the shape `ao start`'s prompt already knows how to render.
  const byProject = new Map<string, string[]>();
  let mostRecent = 0;
  for (const { session, terminatedAt } of candidates) {
    const pid = session.projectId ?? "unknown";
    const list = byProject.get(pid) ?? [];
    list.push(session.id);
    byProject.set(pid, list);
    if (terminatedAt > mostRecent) mostRecent = terminatedAt;
  }

  const primaryIds = byProject.get(primaryProjectId) ?? [];
  byProject.delete(primaryProjectId);
  const otherProjects: Array<{ projectId: string; sessionIds: string[] }> = [];
  for (const [pid, ids] of byProject) {
    otherProjects.push({ projectId: pid, sessionIds: ids });
  }

  return {
    stoppedAt: new Date(mostRecent).toISOString(),
    projectId: primaryProjectId,
    sessionIds: primaryIds,
    ...(otherProjects.length > 0 ? { otherProjects } : {}),
  };
}

/**
 * Scan every project the session manager can see and build a fallback
 * LastStopState from recently `manually_killed` sessions.
 *
 * Returns null on any error (the fallback is best-effort — failing to
 * surface candidates must never block startup).
 */
export async function findRecentlyKilledSessions(
  sm: SessionManager,
  primaryProjectId: string,
  options?: { now?: number; windowMs?: number },
): Promise<LastStopState | null> {
  try {
    const sessions = await sm.list();
    return buildLastStopFallback(sessions, primaryProjectId, options);
  } catch {
    return null;
  }
}
