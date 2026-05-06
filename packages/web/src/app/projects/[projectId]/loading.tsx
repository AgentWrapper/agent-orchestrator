function ProjectLoadingSidebar() {
  return (
    <aside className="project-sidebar flex h-full flex-col" aria-hidden="true">
      <div className="project-sidebar__compact-hdr">
        <span className="project-sidebar__sect-label">Projects</span>
      </div>
      <div className="project-sidebar__tree flex-1 overflow-y-auto overflow-x-hidden">
        <div className="py-2">
          {["w-28", "w-24", "w-32", "w-20"].map((nameWidth, index) => (
            <div
              key={`project-loading-row-${index}`}
              className="flex items-center gap-3 border-b border-[var(--color-border-subtle)] px-4 py-3"
            >
              <div className="h-3 w-3 animate-pulse bg-[color-mix(in_srgb,var(--color-text-primary)_8%,transparent)]" />
              <div
                className={`h-4 animate-pulse bg-[color-mix(in_srgb,var(--color-text-primary)_10%,transparent)] ${nameWidth}`}
              />
              <div className="ml-auto h-6 w-6 animate-pulse border border-[var(--color-border-default)] bg-[var(--color-bg-base)]" />
            </div>
          ))}
        </div>
      </div>
      <div className="project-sidebar__footer">
        <div className="flex items-center gap-2 border-t border-[var(--color-border-subtle)] px-2 py-2">
          <div className="h-7 w-7 animate-pulse border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]" />
          <div className="h-7 w-7 animate-pulse border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]" />
          <div className="h-7 w-7 animate-pulse border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]" />
          <div className="ml-auto h-7 w-7 animate-pulse border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]" />
        </div>
      </div>
    </aside>
  );
}

export default function ProjectRouteLoading() {
  return (
    <div className="min-h-screen bg-[var(--color-bg-canvas)]">
      <div className="dashboard-app-shell">
        <header className="dashboard-app-header" aria-hidden="true">
          <button type="button" className="dashboard-app-sidebar-toggle" aria-label="Toggle sidebar">
            <svg
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18" />
            </svg>
          </button>
          <div className="dashboard-app-header__brand">
            <span className="dashboard-app-header__brand-dot" aria-hidden="true" />
            <span>Agent Orchestrator</span>
          </div>
          <span className="dashboard-app-header__sep" aria-hidden="true" />
          <span className="dashboard-app-header__project">Loading project…</span>
          <div className="dashboard-app-header__spacer" />
          <div className="dashboard-app-header__actions">
            <div className="h-9 w-36 animate-pulse border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]" />
          </div>
        </header>

        <div className="sidebar-wrapper">
          <ProjectLoadingSidebar />
        </div>

        <main className="dashboard-main dashboard-main--desktop overflow-y-auto">
          <div className="dashboard-main__subhead">
            <div className="h-8 w-40 animate-pulse bg-[color-mix(in_srgb,var(--color-bg-elevated)_88%,transparent)]" />
            <div className="mt-3 h-4 w-72 max-w-full animate-pulse bg-[color-mix(in_srgb,var(--color-bg-elevated)_82%,transparent)]" />
          </div>

          <div className="board-wrapper" aria-hidden="true">
            <div className="kanban-ghost">
              {["Working", "Pending", "Review", "Respond", "Merge"].map((label) => (
                <div key={label} className="kanban-ghost__col">
                  <div className="kanban-ghost__head">{label}</div>
                </div>
              ))}
            </div>

            <div className="board-center">
              <div
                className="empty-state"
                role="status"
                aria-label="Loading project dashboard"
              >
                <div className="empty-state__icon" />
                <div className="h-5 w-40 animate-pulse bg-[color-mix(in_srgb,var(--color-bg-elevated)_88%,transparent)]" />
                <div className="h-4 w-56 animate-pulse bg-[color-mix(in_srgb,var(--color-bg-elevated)_82%,transparent)]" />
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
