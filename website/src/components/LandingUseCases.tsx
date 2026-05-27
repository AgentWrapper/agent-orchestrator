const cases = [
  {
    scenario: "Clear a bug backlog overnight",
    before: "10 issues, 3 days of context-switching",
    after: "10 agents, 10 PRs by morning",
    command: "ao batch-spawn 101 102 103 104 105 106 107 108 109 110",
  },
  {
    scenario: "Ship a feature sprint in hours",
    before: "5 feature tickets, 1 dev, 1 week",
    after: "5 agents in parallel, PRs landing same day",
    command: "ao batch-spawn --label feature-sprint",
  },
  {
    scenario: "Migrate an API across 20 files",
    before: "Manual find-and-replace, missed edge cases",
    after: "Agent rewrites, runs tests, fixes failures, opens PR",
    command: "ao spawn 42 --agent claude-code",
  },
];

export function LandingUseCases() {
  return (
    <section className="py-[100px] px-6 max-w-[72rem] mx-auto">
      <div className="landing-reveal">
        <div className="text-xs tracking-[0.2em] uppercase text-[var(--accent-orange)] mb-4 font-mono font-medium">
          Use cases
        </div>
        <h2 className="font-sans font-[680] text-[clamp(1.375rem,3vw,2rem)] leading-[1.1] tracking-[-1.5px] text-gradient-orange">
          What teams run with AO
        </h2>
      </div>
      <div className="flex flex-col gap-6 mt-12 stagger-children">
        {cases.map((c) => (
          <div
            key={c.scenario}
            className="landing-reveal glow-card rounded-2xl p-8 group"
          >
            <h3 className="font-sans font-[680] text-lg tracking-tight text-[var(--landing-fg)] mb-6">
              {c.scenario}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_1fr] gap-4 md:gap-6 items-start">
              <div className="bg-[rgba(255,255,255,0.02)] rounded-xl p-4 border border-[var(--landing-border)]">
                <div className="font-mono text-[0.5625rem] tracking-[0.15em] uppercase text-[var(--landing-muted)] mb-2">
                  Before
                </div>
                <p className="text-[0.8125rem] text-[var(--landing-muted)] leading-relaxed">
                  {c.before}
                </p>
              </div>
              <div className="hidden md:flex items-center justify-center">
                <div className="w-8 h-8 rounded-full bg-[var(--landing-border)] flex items-center justify-center text-[var(--landing-muted-dim)]">
                  →
                </div>
              </div>
              <div className="bg-[rgba(34,197,94,0.04)] rounded-xl p-4 border border-[rgba(34,197,94,0.1)]">
                <div className="font-mono text-[0.5625rem] tracking-[0.15em] uppercase text-[var(--accent-green)] mb-2">
                  After
                </div>
                <p className="text-[0.8125rem] text-[var(--landing-fg)] leading-relaxed">
                  {c.after}
                </p>
              </div>
              <div className="font-mono text-[0.75rem] text-[var(--landing-fg-secondary)] bg-[rgba(0,0,0,0.4)] px-4 py-3 rounded-lg self-center border border-[var(--landing-border)]">
                <span className="text-[var(--accent-orange)] select-none">❯ </span>
                <span className="text-[var(--landing-fg)]">{c.command}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
