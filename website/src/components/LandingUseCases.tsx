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
        <div className="text-xs tracking-[0.15em] uppercase text-[var(--landing-muted-dim)] mb-6 font-mono">
          Use cases
        </div>
        <h2 className="font-sans font-[680] text-[clamp(1.375rem,3vw,2rem)] leading-[1.1] tracking-[-1.5px] mb-16">
          What teams run with AO
        </h2>
      </div>
      <div className="flex flex-col gap-6">
        {cases.map((c) => (
          <div
            key={c.scenario}
            className="landing-reveal landing-card rounded-2xl p-8"
          >
            <h3 className="font-sans font-[680] text-lg tracking-tight mb-4">
              {c.scenario}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_1fr] gap-4 md:gap-6 items-start">
              <div>
                <div className="font-mono text-[0.5625rem] tracking-[0.1em] uppercase text-[var(--landing-muted-dim)] mb-1.5">
                  Before
                </div>
                <p className="text-[0.8125rem] text-[var(--landing-muted)]">
                  {c.before}
                </p>
              </div>
              <div className="hidden md:flex items-center text-[var(--landing-muted-dim)] text-lg">
                →
              </div>
              <div>
                <div className="font-mono text-[0.5625rem] tracking-[0.1em] uppercase text-[rgba(134,239,172,0.7)] mb-1.5">
                  After
                </div>
                <p className="text-[0.8125rem] text-[var(--landing-fg)]">
                  {c.after}
                </p>
              </div>
              <div className="font-mono text-[0.6875rem] text-[var(--landing-muted)] bg-black/30 px-3.5 py-2.5 rounded-lg self-center">
                <span className="text-[var(--landing-muted-dim)]">$</span>{" "}
                {c.command}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
