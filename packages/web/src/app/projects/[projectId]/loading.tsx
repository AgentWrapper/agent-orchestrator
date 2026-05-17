export default function ProjectRouteLoading() {
  return (
    <div className="dashboard-main--desktop">
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
        <div className="dashboard-app-header__brand dashboard-app-header__brand--hide-mobile">
          <span>Agent Orchestrator</span>
        </div>
        <span className="dashboard-app-header__sep topbar-desktop-only" aria-hidden="true" />
        <span className="dashboard-app-header__project">Loading project…</span>
        <div className="dashboard-app-header__spacer" />
      </header>

      <main className="dashboard-main flex-1 min-h-0 overflow-hidden">
        <div className="board-wrapper" aria-hidden="true">
          <div className="kanban-ghost">
            {["Working", "Pending", "Review", "Respond", "Merge"].map((label) => (
              <div key={label} className="kanban-ghost__col">
                <div className="kanban-ghost__head">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
