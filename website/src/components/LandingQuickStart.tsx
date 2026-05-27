const steps = [
  { num: "STEP 01", title: "Install", desc: "One command. No dependencies beyond Node.js.", cmd: "npm i -g @aoagents/ao" },
  { num: "STEP 02", title: "Configure", desc: "Create an agent-orchestrator.yaml. Pick your agents, tracker, and notifiers.", cmd: "ao start" },
  { num: "STEP 03", title: "Launch", desc: "Assign issues and watch agents spawn.", cmd: "ao batch-spawn 1 2 3" },
];

export function LandingQuickStart() {
  return (
    <section className="py-[120px] px-6 max-w-[72rem] mx-auto relative">
      {/* Subtle radial glow background */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.03)_0%,transparent_60%)] pointer-events-none" />

      <div className="landing-reveal relative">
        <div className="text-xs tracking-[0.2em] uppercase text-[var(--accent-cyan)] mb-4 font-mono font-medium">
          Get started in 60 seconds
        </div>
        <h2 className="font-sans font-[680] tracking-tight text-[clamp(1.375rem,3vw,2rem)] leading-[1.05] tracking-[-1.5px]">
          Three commands to{" "}
          <span className="text-gradient-purple">launch</span>
        </h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mt-12 stagger-children relative">
        {steps.map((s, idx) => (
          <div key={s.num} className="landing-reveal shimmer-card rounded-2xl p-7 group relative">
            {/* Step number accent */}
            <div className="absolute top-0 right-6 text-[6rem] font-sans font-[800] leading-none text-[rgba(255,255,255,0.02)] select-none pointer-events-none">
              {idx + 1}
            </div>

            <div className="font-mono text-[0.625rem] tracking-[0.15em] text-[var(--accent-cyan)] mb-4 uppercase">
              {s.num}
            </div>
            <h3 className="font-sans font-[680] tracking-tight text-xl mb-2 tracking-tight text-[var(--landing-fg)] group-hover:text-[var(--accent-cyan)] transition-colors duration-300">
              {s.title}
            </h3>
            <p className="text-[var(--landing-muted)] text-[0.8125rem] leading-[1.6] mb-5">
              {s.desc}
            </p>
            <div className="font-mono text-xs text-[var(--landing-fg-secondary)] bg-[rgba(0,0,0,0.4)] px-4 py-3 rounded-lg border border-[var(--landing-border)]">
              <span className="text-[var(--accent-cyan)] select-none">❯ </span>
              <span>{s.cmd}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="landing-reveal mt-10 text-center relative">
        <a
          href="/docs/"
          className="btn-secondary inline-flex items-center gap-2 rounded-xl px-6 py-3 text-[0.8125rem] no-underline"
        >
          Explore docs for setup and workflows
          <span className="text-[var(--landing-muted)] transition-transform duration-200 group-hover:translate-x-0.5">→</span>
        </a>
      </div>
    </section>
  );
}
