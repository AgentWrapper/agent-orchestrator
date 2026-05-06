const steps = [
  { num: "STEP 01", title: "Install", desc: "One command. No dependencies beyond Node.js.", cmd: "npm i -g @aoagents/ao" },
  { num: "STEP 02", title: "Configure", desc: "Create an agent-orchestrator.yaml. Pick your agents, tracker, and notifiers.", cmd: "ao start" },
  { num: "STEP 03", title: "Launch", desc: "Assign issues and watch agents spawn.", cmd: "ao batch-spawn 1 2 3" },
];

export function LandingQuickStart() {
  return (
    <section className="py-[120px] px-6 max-w-[72rem] mx-auto bg-[radial-gradient(ellipse_at_bottom,rgba(255,255,255,0.015)_0%,transparent_60%)]">
      <div className="landing-reveal">
        <div className="text-xs tracking-[0.15em] uppercase text-[var(--landing-muted)] opacity-60 mb-6">
          Get started in 60 seconds
        </div>
        <h2 className="font-sans font-[680] tracking-tight font-normal text-[clamp(1.375rem,3vw,2rem)] leading-[1.05] tracking-[-1.5px] mb-6">
          Three commands to{" "}
          <em className="italic text-[var(--landing-muted)]">launch</em>
        </h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mt-12">
        {steps.map((s) => (
          <div key={s.num} className="landing-reveal landing-card rounded-2xl p-7">
            <div className="font-mono text-[0.625rem] tracking-[0.1em] text-[var(--landing-muted)] opacity-40 mb-3">
              {s.num}
            </div>
            <h3 className="font-sans font-[680] tracking-tight text-xl mb-2 tracking-tight">
              {s.title}
            </h3>
            <p className="text-[var(--landing-muted)] text-[0.8125rem] leading-[1.6] mb-4">
              {s.desc}
            </p>
            <div className="font-mono text-xs text-[var(--landing-fg)]/70 bg-black/30 px-3.5 py-2.5 rounded-lg">
              <span className="text-[var(--landing-muted)] opacity-40">$</span> {s.cmd}
            </div>
          </div>
        ))}
      </div>
      <div className="landing-reveal mt-8 text-center">
        <a href="/docs/" className="landing-card inline-flex rounded-lg px-4 py-2 text-[0.8125rem] text-[var(--landing-muted)] no-underline hover:text-white transition-colors">
          Explore docs for setup and workflows
        </a>
      </div>
    </section>
  );
}
