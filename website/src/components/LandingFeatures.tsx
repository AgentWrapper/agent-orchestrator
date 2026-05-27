const features = [
  {
    label: "PARALLEL",
    title: "Multi-agent execution",
    desc: "Run Claude Code, Codex, Cursor, Aider, and OpenCode simultaneously. Each agent gets its own git worktree, its own branch, its own context.",
    icon: "⚡",
    accent: "var(--accent-orange)",
    span: "col-span-1 md:col-span-2",
  },
  {
    label: "RECOVERY",
    title: "Autonomous CI + review handling",
    desc: "CI fails? The agent reads the logs and pushes a fix. Review comments land? The agent addresses them. You sleep, your agents ship.",
    icon: "🔄",
    accent: "var(--accent-green)",
    span: "col-span-1 md:col-span-1",
  },
  {
    label: "PLUGINS",
    title: "7 swappable slots",
    desc: "Runtime, Agent, Workspace, Tracker, SCM, Notifier, Terminal. Use tmux or process. GitHub or GitLab. Slack or webhooks. Swap anything.",
    icon: "🧩",
    accent: "var(--accent-purple)",
    span: "col-span-1 md:col-span-1",
  },
  {
    label: "DASHBOARD",
    title: "Real-time Kanban + terminal",
    desc: "Every agent's state in one view. Attach to any terminal via the browser. SSE updates every 5 seconds. WebSocket for live terminal I/O.",
    icon: "📊",
    accent: "var(--accent-cyan)",
    span: "col-span-1 md:col-span-2",
  },
];

export function LandingFeatures() {
  return (
    <section className="py-[140px] px-6 max-w-[72rem] mx-auto" id="features">
      <div className="landing-reveal">
        <div className="font-mono text-[0.75rem] tracking-[0.2em] uppercase text-[var(--accent-orange)] mb-4">
          Capabilities
        </div>
        <h2 className="text-[clamp(2rem,5vw,3.5rem)] leading-[1.1] tracking-[-1.5px] font-bold mb-4">
          What it does
        </h2>
        <a href="/docs" className="text-[0.9375rem] text-[var(--landing-muted)] no-underline hover:text-[var(--landing-fg)] transition-colors">
          Explore full docs and plugin references →
        </a>
      </div>

      {/* Bento grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-14">
        {features.map((f) => (
          <div
            key={f.label}
            className={`landing-reveal glow-card ${f.span} p-8 group`}
          >
            {/* Icon */}
            <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl mb-6" style={{
              background: `color-mix(in srgb, ${f.accent} 10%, transparent)`,
            }}>
              {f.icon}
            </div>

            {/* Label */}
            <div className="font-mono text-[0.625rem] tracking-[0.15em] uppercase mb-3" style={{ color: f.accent }}>
              {f.label}
            </div>

            {/* Title */}
            <h3 className="text-xl font-bold tracking-tight mb-3">
              {f.title}
            </h3>

            {/* Description */}
            <p className="text-[var(--landing-muted)] text-[0.9375rem] leading-[1.75]">
              {f.desc}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
