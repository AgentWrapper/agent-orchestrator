"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { DashboardSession } from "@/lib/types";
import { useResizable } from "@/hooks/useResizable";
import { StatusBadge } from "./StatusBadge";
import { SessionDetailPRCard } from "./SessionDetailPRCard";
import { askAgentToFix } from "./session-detail-agent-actions";
import { formatTimeCompact } from "./session-detail-utils";

type InspectorView = "summary" | "changes" | "browser";

interface SessionInspectorProps {
  session: DashboardSession;
}

const VIEWS: { id: InspectorView; label: string; icon: ReactNode }[] = [
  {
    id: "summary",
    label: "Summary",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <line x1="8" y1="7" x2="20" y2="7" />
        <line x1="8" y1="12" x2="20" y2="12" />
        <line x1="8" y1="17" x2="16" y2="17" />
        <circle cx="4" cy="7" r="1" />
        <circle cx="4" cy="12" r="1" />
        <circle cx="4" cy="17" r="1" />
      </svg>
    ),
  },
  {
    id: "changes",
    label: "Changes",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <path d="M12 3v6" />
        <path d="M9 6h6" />
        <path d="M11 18H7a2 2 0 0 1-2-2V6" />
        <path d="M13 15h4" />
        <path d="M19 9v7a2 2 0 0 1-2 2h-2" />
      </svg>
    ),
  },
  {
    id: "browser",
    label: "Browser",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18" />
      </svg>
    ),
  },
];

/**
 * Pluggable inspector rail beside the framed terminal. Each view is a
 * registered entry (Summary · Changes · Browser); adding more (Logs, Cost…)
 * is just another VIEWS entry + a branch in renderView. The Summary view is
 * ordered by supervision value: Pull request → Review comments → Activity →
 * Overview (the PR card bundles the first two, incl. the soft-blue Address
 * action that hands a comment + file:line to the agent).
 */
export function SessionInspector({ session }: SessionInspectorProps) {
  const [view, setView] = useState<InspectorView>("summary");
  const { onPointerDown, onDoubleClick } = useResizable({
    cssVar: "--ao-inspector-w",
    storageKey: "ao-inspector-w",
    defaultWidth: 344,
    min: 280,
    max: 560,
    edge: "left",
  });

  return (
    <aside className="session-inspector" aria-label="Session inspector">
      <div
        className="resize-handle resize-handle--left"
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspector"
      />
      <div className="session-inspector__tabs" role="tablist">
        {VIEWS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={view === entry.id}
            className={cn("session-inspector__tab", view === entry.id && "is-active")}
            onClick={() => setView(entry.id)}
          >
            <span className="session-inspector__tab-icon">{entry.icon}</span>
            <span className="session-inspector__tab-label">{entry.label}</span>
          </button>
        ))}
      </div>

      <div className="session-inspector__body">
        {view === "summary" ? <SummaryView session={session} /> : null}
        {view === "changes" ? <ChangesView session={session} /> : null}
        {view === "browser" ? <BrowserView /> : null}
      </div>
    </aside>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="inspector-section">
      <div className="inspector-section__head">
        <span>{title}</span>
        {action ?? null}
      </div>
      {children}
    </section>
  );
}

function SummaryView({ session }: { session: DashboardSession }) {
  const pr = session.pr;
  return (
    <div role="tabpanel">
      <Section
        title="Pull request"
        action={
          pr ? (
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inspector-section__link"
            >
              Open ↗
            </a>
          ) : undefined
        }
      >
        {pr ? (
          <SessionDetailPRCard
            pr={pr}
            metadata={session.metadata}
            lifecyclePrReason={session.lifecycle?.prReason ?? undefined}
            onAskAgentToFix={(comment, onSuccess, onError) =>
              askAgentToFix(session.id, comment, onSuccess, onError)
            }
          />
        ) : (
          <p className="inspector-empty">No pull request opened yet.</p>
        )}
      </Section>

      <Section title="Activity">
        <ActivityTimeline session={session} />
      </Section>

      <Section title="Overview">
        <dl className="inspector-kv">
          {session.metadata["agent"] ? <Row k="Agent" v={session.metadata["agent"]} mono /> : null}
          {session.branch ? <Row k="Branch" v={session.branch} mono /> : null}
          {session.issueLabel ? <Row k="Issue" v={session.issueLabel} mono /> : null}
          <Row k="Started" v={formatTimeCompact(session.createdAt)} mono />
          <Row k="Session" v={session.id} mono />
        </dl>
      </Section>
    </div>
  );
}

type TimelineTone = "now" | "good" | "warn" | "neutral";

/**
 * Honest activity timeline — only events we can derive from the session object:
 * the live status (now), the PR (good), the last-active beat, and worktree
 * creation (oldest). No fabricated commit/CI rows.
 */
function ActivityTimeline({ session }: { session: DashboardSession }) {
  const events: { tone: TimelineTone; node: ReactNode; ts: string | null }[] = [];

  events.push({
    tone: "now",
    node: (
      <>
        <span className="inspector-timeline__badge">
          <StatusBadge session={session} variant="pill" />
        </span>
        {session.lifecycle?.summary ? (
          <span className="inspector-timeline__detail"> — {session.lifecycle.summary}</span>
        ) : null}
      </>
    ),
    ts: formatTimeCompact(session.lastActivityAt),
  });

  if (session.pr) {
    events.push({
      tone: "good",
      node: (
        <>
          Opened <b>PR #{session.pr.number}</b>
          {session.pr.baseBranch ? ` against ${session.pr.baseBranch}` : ""}
        </>
      ),
      ts: null,
    });
  }

  events.push({
    tone: "neutral",
    node: <>Created worktree &amp; branch</>,
    ts: formatTimeCompact(session.createdAt),
  });

  return (
    <div className="inspector-timeline">
      {events.map((event, index) => (
        <div
          key={index}
          className={cn(
            "inspector-timeline__ev",
            event.tone === "now" && "inspector-timeline__ev--now",
            event.tone === "good" && "inspector-timeline__ev--good",
            event.tone === "warn" && "inspector-timeline__ev--warn",
          )}
        >
          <span className="inspector-timeline__node" aria-hidden="true" />
          <div className="inspector-timeline__et">{event.node}</div>
          {event.ts ? <div className="inspector-timeline__ets">{event.ts}</div> : null}
        </div>
      ))}
    </div>
  );
}

function ChangesView({ session }: { session: DashboardSession }) {
  const pr = session.pr;
  if (!pr || (pr.additions === 0 && pr.deletions === 0)) {
    return (
      <div role="tabpanel">
        <p className="inspector-empty">No changes pushed yet.</p>
      </div>
    );
  }
  const files = pr.changedFiles ?? 0;
  return (
    <div role="tabpanel">
      <Section
        title="Working tree"
        action={
          <a
            href={`${pr.url}/files`}
            target="_blank"
            rel="noopener noreferrer"
            className="inspector-section__link"
          >
            View diff ↗
          </a>
        }
      >
        <div className="inspector-diff-sum">
          {files > 0 ? <span>{`${files} file${files === 1 ? "" : "s"}`}</span> : null}
          <span className="session-detail-diff--add">+{pr.additions}</span>
          <span className="session-detail-diff--del">−{pr.deletions}</span>
        </div>
        <p className="inspector-hint">
          The full diff opens on GitHub. Inline diff rendering is a future inspector view.
        </p>
      </Section>
    </div>
  );
}

function BrowserView() {
  return (
    <div role="tabpanel">
      <div className="inspector-empty inspector-empty--browser">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18" />
        </svg>
        <p>No live browser preview.</p>
        <span>
          A browser plugin (web preview / Playwright) will render what the agent is viewing here.
        </span>
      </div>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="inspector-kv__row">
      <dt className="inspector-kv__k">{k}</dt>
      <dd className={cn("inspector-kv__v", mono && "inspector-kv__v--mono")}>{v}</dd>
    </div>
  );
}
