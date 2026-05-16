/**
 * Pure formatting utilities safe for both server and client components.
 * No side effects, no external dependencies.
 */

import type { DashboardSession } from "./types.js";

/**
 * Humanize a git branch name into a readable title.
 *
 * Strips common branch prefixes (feat/, fix/, session/, orchestrator/, …) then
 * title-cases the remainder.
 *
 * When `sessionId` is provided and the stripped branch is equal to the session
 * ID (i.e. the branch is just `session/ao-42` or `orchestrator/ao-orchestrator-8`),
 * this function returns an empty string. That signals to {@link getSessionTitle}
 * that the branch carries no task information beyond the session ID and should
 * be skipped in the fallback chain so the display name doesn't read like
 * "Ao Orchestrator 8".
 *
 * @example
 *   humanizeBranch("feat/infer-project-id")           // → "Infer Project Id"
 *   humanizeBranch("orchestrator/ao-orchestrator-8", "ao-orchestrator-8") // → ""
 *   humanizeBranch("session/ao-52", "ao-52")          // → ""
 */
export function humanizeBranch(branch: string, sessionId?: string): string {
  // Remove common prefixes (keep in sync with actual branch-generation logic
  // in packages/core/src/session-manager.ts — `session/`, `orchestrator/`, and
  // `feat/` are produced by spawn()/spawnOrchestrator()).
  const withoutPrefix = branch.replace(
    /^(?:feat|fix|chore|refactor|docs|test|ci|session|orchestrator|release|hotfix|feature|bugfix|build|wip|improvement)\//,
    "",
  );

  // If the remaining text is just the session ID (e.g. "ao-42" or
  // "ao-orchestrator-8"), there's no task signal here — return empty so the
  // caller can fall through to the next fallback (displayName, summary, …).
  if (sessionId && withoutPrefix === sessionId) {
    return "";
  }

  // Replace hyphens and underscores with spaces, then title-case each word
  return withoutPrefix
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Compute the best display title for a session card.
 *
 * Fallback chain (ordered by signal quality):
 *   1. User-set display name — only when `displayNameUserSet` is true.
 *                              An explicit rename always wins so the user's
 *                              chosen label isn't shadowed by tracker signals.
 *   2. PR title              — human-visible deliverable name
 *   3. Issue title           — human-written task description (live from tracker)
 *   4. Auto-derived display  — captured at spawn from issue title / user prompt /
 *      name                    orchestrator system prompt. Stays BELOW PR/issue
 *                              titles so a stale spawn-time value doesn't
 *                              shadow the live deliverable name.
 *   5. User prompt           — raw freeform spawn instructions (fallback for
 *                              sessions spawned before `displayName` existed)
 *   6. Humanized branch      — stable task identifier when no explicit title
 *                              exists (skipped when it collapses to just the
 *                              session ID)
 *   7. Pinned summary        — first quality summary, stable across agent updates
 *   8. Quality summary       — live summary, but can drift as the session evolves
 *   9. Any summary           — even a fallback excerpt is better than nothing
 *  10. Status text           — absolute fallback
 */
export function getSessionTitle(session: DashboardSession): string {
  // 1. User-set rename — wins over everything when explicitly flagged.
  if (session.displayName && session.displayNameUserSet) {
    return session.displayName;
  }

  // 2. PR title
  if (session.pr?.title) return session.pr.title;

  // 3. Issue title — human-written task description
  if (session.issueTitle) return session.issueTitle;

  // 4. Auto-derived displayName — captured at spawn time. Sits below PR/issue
  // but above userPrompt: for prompt-only sessions both are populated from the
  // same `spawnConfig.prompt`; `displayName` is the cleaned single-line,
  // 80-char-truncated version and should win so kanban cards don't show raw
  // multi-line prompts.
  if (session.displayName) return session.displayName;

  // 5. User prompt — raw freeform spawn instructions. Only reached when
  // `displayName` is absent (older sessions spawned before this field existed,
  // or sessions where derivation failed).
  if (session.userPrompt) return session.userPrompt;

  // 5. Humanized branch — stable semantic fallback.
  // humanizeBranch returns "" when the branch is just the session ID
  // (e.g. "session/ao-42", "orchestrator/ao-orchestrator-8"), which signals
  // we should skip ahead to the summary fallbacks instead of showing noise.
  if (session.branch) {
    const humanized = humanizeBranch(session.branch, session.id);
    if (humanized) return humanized;
  }

  // 6. Pinned summary — first quality summary, stable across agent updates
  const pinnedSummary = session.metadata["pinnedSummary"];
  if (pinnedSummary) return pinnedSummary;

  // 7. Quality summary — skip fallback summaries (truncated spawn prompts)
  if (session.summary && !session.summaryIsFallback) {
    return session.summary;
  }

  // 8. Any summary — even fallback excerpts beat raw status text
  if (session.summary) return session.summary;

  // 9. Status
  return session.status;
}

export function formatRelativeTime(input: number): string {
  const elapsedMs = Date.now() - input;

  if (elapsedMs < 60_000) return "just now";

  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}
