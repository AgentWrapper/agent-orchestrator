export function LandingAbout() {
  return (
    <div className="bg-[radial-gradient(ellipse_at_top,rgba(255,240,220,0.015)_0%,transparent_70%)]">
      <section className="landing-reveal py-[100px] px-6 max-w-[72rem] mx-auto">
        <div className="text-xs tracking-[0.15em] uppercase text-[var(--landing-muted-dim)] mb-6 font-mono">
          The problem
        </div>
        <h2 className="font-sans font-[680] text-[clamp(1.375rem,3vw,2rem)] leading-[1.1] tracking-[-1.5px] mb-10 max-w-[48rem]">
          You&apos;re running AI agents in 10 browser tabs.{" "}
          <span className="text-[var(--landing-muted)]">
            Checking if PRs landed. Re-running failed CI. Copy-pasting error logs.
          </span>
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
          <p className="text-[0.9375rem] text-[var(--landing-muted)] leading-[1.8] max-w-[28rem]">
            Agent Orchestrator replaces that with one YAML file. Point it at
            your GitHub issues, pick your agents, and walk away. Each agent
            spawns in its own git worktree, creates PRs, fixes CI failures,
            addresses review comments, and moves toward merge. If you are new, start with the <a href="/docs/" className="underline decoration-[var(--landing-border-default)] underline-offset-4 hover:text-white">docs quickstart and configuration guides</a>.
          </p>

          {/* Config preview — show how simple setup is */}
          <div className="landing-card rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--landing-border-subtle)]">
              <div className="w-2 h-2 rounded-full bg-[rgba(255,240,220,0.12)]" />
              <div className="w-2 h-2 rounded-full bg-[rgba(255,240,220,0.12)]" />
              <div className="w-2 h-2 rounded-full bg-[rgba(255,240,220,0.12)]" />
              <span className="ml-1.5 font-mono text-[0.5625rem] text-[var(--landing-muted-dim)]">
                agent-orchestrator.yaml
              </span>
            </div>
            <pre className="px-5 py-4 font-mono text-[0.75rem] leading-[1.9] overflow-x-auto">
              <span className="text-[var(--landing-muted-dim)]">agent:</span>{" "}
              <span className="text-[var(--landing-fg)]">claude-code</span>
              {"\n"}
              <span className="text-[var(--landing-muted-dim)]">tracker:</span>{" "}
              <span className="text-[var(--landing-fg)]">github</span>
              {"\n"}
              <span className="text-[var(--landing-muted-dim)]">workspace:</span>{" "}
              <span className="text-[var(--landing-fg)]">worktree</span>
              {"\n"}
              <span className="text-[var(--landing-muted-dim)]">runtime:</span>{" "}
              <span className="text-[var(--landing-fg)]">tmux</span>
              {"\n"}
              <span className="text-[var(--landing-muted-dim)]">notifier:</span>{" "}
              <span className="text-[var(--landing-fg)]">slack</span>
            </pre>
          </div>
        </div>
      </section>
    </div>
  );
}
