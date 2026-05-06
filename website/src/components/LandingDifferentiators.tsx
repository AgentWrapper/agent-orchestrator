const rows = [
  { feature: "Web-based dashboard", others: "Native Mac apps only" },
  { feature: "Open source (MIT)", others: "Closed source" },
  { feature: "Multi-agent (Claude, Codex, Aider, OpenCode)", others: "Single agent" },
  { feature: "Auto CI failure recovery", others: "Manual" },
  { feature: "Plugin architecture (7 slots)", others: "Fixed integrations" },
  { feature: "Git worktree isolation", others: "Shared workspace" },
];

export function LandingDifferentiators() {
  return (
    <section className="py-[100px] px-6 max-w-[72rem] mx-auto">
      <div className="landing-reveal">
        <div className="text-xs tracking-[0.15em] uppercase text-[var(--landing-muted)] opacity-60 mb-6">
          Why Agent Orchestrator
        </div>
        <h2 className="font-sans font-[680] tracking-tight font-normal text-[clamp(1.375rem,3vw,2rem)] leading-[1.1] tracking-[-1.5px] mb-6 max-w-[42rem]">
          The only{" "}
          <em className="italic text-[var(--landing-muted)]">open-source, web-based</em>{" "}
          agent orchestrator
        </h2>
        <p className="text-[0.9375rem] text-[var(--landing-muted)] leading-[1.7] max-w-[36rem] mb-12">
          Conductor, T3 Code, and Codex App are native Mac apps. AO runs in
          your browser, works on any OS, and you can self-host or extend it.
        </p>
      </div>
      <div className="landing-reveal landing-card rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--landing-border-subtle)]">
              <th className="text-left px-6 py-4 font-mono text-[0.625rem] tracking-[0.1em] uppercase text-[var(--landing-muted)] opacity-40">
                Feature
              </th>
              <th className="text-center px-6 py-4 font-mono text-[0.625rem] tracking-[0.1em] uppercase text-[var(--landing-fg)] opacity-80">
                AO
              </th>
              <th className="text-center px-6 py-4 font-mono text-[0.625rem] tracking-[0.1em] uppercase text-[var(--landing-muted)] opacity-40">
                Others
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={row.feature}
                className={i < rows.length - 1 ? "border-b border-[var(--landing-border-subtle)]" : ""}
              >
                <td className="px-6 py-3.5 text-[0.8125rem] text-[var(--landing-fg)]/80">
                  {row.feature}
                </td>
                <td className="px-6 py-3.5 text-center text-[rgba(134,239,172,0.8)]">
                  ✓
                </td>
                <td className="px-6 py-3.5 text-center text-[0.75rem] text-[var(--landing-muted)] opacity-40">
                  {row.others}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
