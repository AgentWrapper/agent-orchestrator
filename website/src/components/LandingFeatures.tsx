const features = [
  {
    label: "PARALLEL",
    title: "Multi-agent execution",
    desc: "Run Claude Code, Codex, Cursor, Aider, and OpenCode simultaneously. Each agent gets its own git worktree, its own branch, its own context.",
  },
  {
    label: "RECOVERY",
    title: "Autonomous CI + review handling",
    desc: "CI fails? The agent reads the logs and pushes a fix. Review comments land? The agent addresses them. You sleep, your agents ship.",
  },
  {
    label: "PLUGINS",
    title: "7 swappable slots",
    desc: "Runtime, Agent, Workspace, Tracker, SCM, Notifier, Terminal. Use tmux or process. GitHub or GitLab. Slack or webhooks. Swap anything.",
  },
  {
    label: "DASHBOARD",
    title: "Real-time Kanban + terminal",
    desc: "Every agent's state in one view. Attach to any terminal via the browser. SSE updates every 5 seconds. WebSocket for live terminal I/O.",
  },
];

export function LandingFeatures() {
  return (
    <section className="py-[100px] px-6 max-w-[72rem] mx-auto" id="features">
      <div className="landing-reveal">
        <div className="text-xs tracking-[0.15em] uppercase text-[var(--landing-muted-dim)] mb-6 font-mono">
          Capabilities
        </div>
        <h2 className="font-sans font-[680] text-[clamp(2rem,5vw,3.5rem)] leading-[1.1] tracking-[-1.5px] mb-5">
          What it does
        </h2>
        <a href="/docs" className="text-[0.8125rem] text-[var(--landing-muted)] no-underline hover:text-white transition-colors">
          Explore full docs and plugin references
        </a>
      </div>
      <div className="flex flex-col gap-0 mt-6">
        {features.map((f, i) => (
          <div
            key={f.label}
            className={`landing-reveal flex flex-col md:flex-row md:items-baseline gap-3 md:gap-12 py-8 ${
              i < features.length - 1
                ? "border-b border-[var(--landing-border-subtle)]"
                : ""
            }`}
          >
            <div className="font-mono text-[0.625rem] tracking-[0.12em] text-[var(--landing-muted-dim)] w-20 shrink-0">
              {f.label}
            </div>
            <div className="flex-1">
              <h3 className="font-sans font-[680] text-lg tracking-tight mb-1.5">
                {f.title}
              </h3>
              <p className="text-[var(--landing-muted)] text-[0.875rem] leading-[1.7] max-w-[36rem]">
                {f.desc}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}