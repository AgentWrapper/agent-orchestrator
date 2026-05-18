"use client";

import type { Artifact } from "@aoagents/ao-core";
import { useMemo } from "react";
import { useArtifacts } from "@/hooks/useArtifacts";
import {
  useArtifactCollapsed,
  useArtifactOrder,
  applyArtifactOrder,
} from "@/hooks/useArtifactUiState";
import { ArtifactMarkdown } from "./ArtifactMarkdown";
import { ArtifactHtml } from "./ArtifactHtml";
import { ArtifactCardControls } from "./ArtifactCardControls";

interface ArtifactRailProps {
  sessionId: string;
  /** Click handler for the rail-level "collapse" affordance in the header. */
  onCollapseRail?: () => void;
}

/**
 * Right-rail container for artifact cards on the session detail page.
 *
 * Fetches artifacts via `useArtifacts` (REST + mux push). Renders each artifact
 * through the appropriate type-specific component (markdown / html), wrapped
 * with per-card chrome (collapse toggle + up/down reorder buttons).
 *
 * Render order: user-chosen explicit order first (per-session, persisted to
 * localStorage), then default updatedAt desc for any artifacts the user
 * hasn't explicitly placed.
 */
export function ArtifactRail({ sessionId, onCollapseRail }: ArtifactRailProps) {
  const { artifacts, loading, error } = useArtifacts(sessionId);
  const { order, moveUp, moveDown } = useArtifactOrder(sessionId);

  const ordered = useMemo(() => {
    const defaultSorted = [...artifacts].sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    );
    return applyArtifactOrder(defaultSorted, order);
  }, [artifacts, order]);

  const orderedIds = useMemo(() => ordered.map((a) => a.id), [ordered]);

  if (loading) {
    return (
      <RailShell onCollapseRail={onCollapseRail}>
        <div className="text-sm text-[var(--color-text-muted)]">Loading artifacts…</div>
      </RailShell>
    );
  }

  if (error) {
    return (
      <RailShell onCollapseRail={onCollapseRail}>
        <div className="text-sm text-[var(--color-status-error)]">
          Failed to load artifacts: {error}
        </div>
      </RailShell>
    );
  }

  if (ordered.length === 0) {
    return (
      <RailShell count={0} onCollapseRail={onCollapseRail}>
        <div className="text-sm text-[var(--color-text-muted)]">No artifacts yet.</div>
      </RailShell>
    );
  }

  return (
    <RailShell count={ordered.length} onCollapseRail={onCollapseRail}>
      <div className="artifact-rail-list flex flex-1 flex-col gap-2 overflow-y-auto">
        {ordered.map((artifact, idx) => (
          <ArtifactCard
            key={artifact.id}
            artifact={artifact}
            isFirst={idx === 0}
            isLast={idx === ordered.length - 1}
            onMoveUp={() => moveUp(artifact.id, orderedIds)}
            onMoveDown={() => moveDown(artifact.id, orderedIds)}
          />
        ))}
      </div>
    </RailShell>
  );
}

function RailShell({
  count,
  children,
  onCollapseRail,
}: {
  count?: number;
  children: React.ReactNode;
  onCollapseRail?: () => void;
}) {
  return (
    <aside
      className="artifact-rail flex h-full w-full flex-col gap-2 border-l border-[var(--color-border-subtle)] bg-[var(--color-bg-sidebar)] p-3"
      aria-label="Artifacts"
    >
      <header className="artifact-rail-header flex shrink-0 items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Artifacts</h3>
        <div className="flex items-center gap-2">
          {typeof count === "number" && (
            <span className="artifact-rail-count text-xs text-[var(--color-text-muted)]">
              {count}
            </span>
          )}
          {onCollapseRail && (
            <button
              type="button"
              onClick={onCollapseRail}
              aria-label="Collapse artifacts rail"
              title="Collapse rail"
              className="flex h-5 w-5 items-center justify-center rounded text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
            >
              ›
            </button>
          )}
        </div>
      </header>
      {children}
    </aside>
  );
}

function ArtifactCard({
  artifact,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
}: {
  artifact: Artifact;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const { collapsed, toggle } = useArtifactCollapsed(artifact.id);

  const controls = (
    <ArtifactCardControls
      collapsed={collapsed}
      onToggleCollapse={toggle}
      onMoveUp={onMoveUp}
      onMoveDown={onMoveDown}
      canMoveUp={!isFirst}
      canMoveDown={!isLast}
    />
  );

  switch (artifact.type) {
    case "markdown":
      return <ArtifactMarkdown artifact={artifact} collapsed={collapsed} controls={controls} />;
    case "html":
      return <ArtifactHtml artifact={artifact} collapsed={collapsed} controls={controls} />;
  }
}
