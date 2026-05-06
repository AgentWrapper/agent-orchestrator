// ── State UI ──────────────────────────────────────────────────────────

interface EmptyStateProps {
  message?: string;
  orchestratorHref?: string | null;
  onSpawnOrchestrator?: (() => void) | null;
  spawnLabel?: string;
  spawnDisabled?: boolean;
}

const KANBAN_GHOST_COLUMNS = ["Working", "Pending", "Review", "Respond", "Merge"] as const;

export function EmptyState({
  message,
  orchestratorHref,
  onSpawnOrchestrator = null,
  spawnLabel = "Spawn Orchestrator",
  spawnDisabled = false,
}: EmptyStateProps) {
  return (
    <div className="board-wrapper">
      <div className="kanban-ghost" aria-hidden="true">
        {KANBAN_GHOST_COLUMNS.map((label) => (
          <div key={label} className="kanban-ghost__col">
            <div className="kanban-ghost__head">{label}</div>
          </div>
        ))}
      </div>

      <div className="board-center">
        <div className="empty-state" role="status">
          <div className="empty-state__icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle
                cx="12"
                cy="5.5"
                r="2.5"
                fill="rgba(249,115,22,0.18)"
                stroke="#f97316"
                strokeWidth="1.5"
              />
              <circle
                cx="5.5"
                cy="17"
                r="2.5"
                fill="var(--color-bg-subtle)"
                stroke="var(--color-border-strong)"
                strokeWidth="1.5"
              />
              <circle
                cx="18.5"
                cy="17"
                r="2.5"
                fill="var(--color-bg-subtle)"
                stroke="var(--color-border-strong)"
                strokeWidth="1.5"
              />
              <line
                x1="12"
                y1="8"
                x2="6.7"
                y2="14.8"
                stroke="rgba(249,115,22,0.22)"
                strokeWidth="1"
                strokeDasharray="2.5 2"
              />
              <line
                x1="12"
                y1="8"
                x2="17.3"
                y2="14.8"
                stroke="rgba(249,115,22,0.22)"
                strokeWidth="1"
                strokeDasharray="2.5 2"
              />
              <line
                x1="7.8"
                y1="17"
                x2="16.2"
                y2="17"
                stroke="var(--color-border-subtle)"
                strokeWidth="1"
                strokeDasharray="2.5 2"
              />
            </svg>
          </div>
          {message ? (
            <p className="empty-state__text">{message}</p>
          ) : (
            <>
              <p className="empty-state__headline">Ready to orchestrate</p>
              <p className="empty-state__hint">
                Open the main orchestrator to start a session and fan out parallel agents across your codebase.
              </p>
              {orchestratorHref ? (
                <a href={orchestratorHref} className="empty-state__cta">
                  <svg
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="5" r="2" fill="currentColor" stroke="none" />
                    <path d="M12 7v4M12 11H6M12 11h6M6 11v3M12 11v3M18 11v3" />
                    <circle cx="6" cy="17" r="2" />
                    <circle cx="12" cy="17" r="2" />
                    <circle cx="18" cy="17" r="2" />
                  </svg>
                  Open Orchestrator
                </a>
              ) : onSpawnOrchestrator ? (
                <button
                  type="button"
                  className="empty-state__cta"
                  onClick={onSpawnOrchestrator}
                  disabled={spawnDisabled}
                >
                  <svg
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="5" r="2" fill="currentColor" stroke="none" />
                    <path d="M12 7v4M12 11H6M12 11h6M6 11v3M12 11v3M18 11v3" />
                    <circle cx="6" cy="17" r="2" />
                    <circle cx="12" cy="17" r="2" />
                    <circle cx="18" cy="17" r="2" />
                  </svg>
                  {spawnLabel}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
