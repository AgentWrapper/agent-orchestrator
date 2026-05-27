export function LandingCTA() {
  return (
    <section className="relative py-[160px] px-6 text-center overflow-hidden">
      {/* Background glow */}
      <div className="absolute inset-0" style={{
        background: "radial-gradient(ellipse 60% 50% at 50% 50%, rgba(249,115,22,0.06) 0%, transparent 70%)"
      }} />

      <div className="relative landing-reveal">
        <p className="text-[var(--landing-muted)] text-2xl font-bold tracking-tight mb-4">
          Stop babysitting.
        </p>
        <h2 className="text-[clamp(1.5rem,3vw,2.25rem)] leading-[1.1] tracking-[-1px] font-bold mb-6">
          Start <span className="text-gradient-orange">orchestrating.</span>
        </h2>

        {/* Install command */}
        <div className="landing-card inline-flex items-center gap-3 rounded-xl px-7 py-4 font-mono text-[0.9375rem] mb-10" style={{
          background: "rgba(0,0,0,0.4)",
          backdropFilter: "blur(10px)"
        }}>
          <span className="text-[var(--accent-orange)]">$</span>
          <span className="text-[var(--landing-fg)]">npm i -g @aoagents/ao</span>
        </div>

        <div className="flex items-center justify-center gap-4 flex-wrap">
          <a href="/docs" className="btn-primary">
            Read Docs →
          </a>
          <a
            href="https://github.com/ComposioHQ/agent-orchestrator"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary"
          >
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
