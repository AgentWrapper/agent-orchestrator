export function LandingCTA() {
  return (
    <section className="text-center py-40 px-6 bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.015)_0%,transparent_60%)]">
      <div className="landing-reveal">
        <p className="text-[var(--landing-muted)] opacity-50 text-2xl font-sans font-[680] tracking-tight mb-4">
          Stop babysitting.
        </p>
        <h2 className="font-sans font-[680] tracking-tight font-normal text-[clamp(1.375rem,3vw,2rem)] leading-[1.05] tracking-[-2px] mb-4">
          Start <em className="italic text-[var(--landing-muted)]">orchestrating.</em>
        </h2>
        <div className="landing-card inline-flex items-center gap-3 rounded-lg px-6 py-3 font-mono text-[0.9375rem] text-white mb-8">
          <span className="text-[var(--landing-muted)] opacity-40">$</span> npm i -g @aoagents/ao
        </div>
        <div className="flex items-center justify-center gap-4 flex-wrap">
          <a
            href="/docs"
            className="landing-card rounded-lg px-6 py-3 text-[0.9375rem] text-[var(--landing-muted)] no-underline transition-colors hover:text-white"
          >
            Read Docs
          </a>
          <a
            href="https://github.com/ComposioHQ/agent-orchestrator"
            target="_blank"
            rel="noopener noreferrer"
            className="liquid-glass-solid rounded-lg px-6 py-3 text-[0.9375rem] no-underline transition-transform hover:scale-[1.03]"
          >
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
