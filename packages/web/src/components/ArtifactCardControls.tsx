"use client";

/**
 * Small button row rendered in the top-right of each artifact card.
 *
 *   ▲   move up (disabled if first)
 *   ▼   move down (disabled if last)
 *   ▾/▸ collapse / expand (toggles)
 *
 * Rendered into ArtifactMarkdown / ArtifactHtml via their `controls` slot.
 * The rail owns the state — these buttons are pure callbacks.
 */

interface Props {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

export function ArtifactCardControls({
  collapsed,
  onToggleCollapse,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}: Props) {
  return (
    <div className="artifact-card-controls flex items-center gap-0.5">
      <ControlButton
        label="Move up"
        onClick={onMoveUp}
        disabled={!canMoveUp || !onMoveUp}
      >
        ▲
      </ControlButton>
      <ControlButton
        label="Move down"
        onClick={onMoveDown}
        disabled={!canMoveDown || !onMoveDown}
      >
        ▼
      </ControlButton>
      <ControlButton
        label={collapsed ? "Expand" : "Collapse"}
        onClick={onToggleCollapse}
      >
        {collapsed ? "▸" : "▾"}
      </ControlButton>
    </div>
  );
}

function ControlButton({
  children,
  label,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-5 w-5 items-center justify-center rounded text-[10px] leading-none text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--color-text-muted)]"
    >
      {children}
    </button>
  );
}
