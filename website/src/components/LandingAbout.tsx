'use client';

export function LandingAbout() {
  return (
    <section className="landing-reveal relative">
      {/* Subtle radial glow behind section */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[500px] bg-[radial-gradient(ellipse_at_center,rgba(249,115,22,0.04)_0%,transparent_70%)]" />
      </div>

      <div className="relative py-[120px] px-6 max-w-[72rem] mx-auto">
        {/* ── Section Label ─────────────────────────────────────── */}
        <div className="flex items-center gap-3 mb-8">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--accent-orange)] landing-pulse-dot" />
          <span className="font-mono text-[0.6875rem] tracking-[0.2em] uppercase text-[var(--accent-orange)]">
            The problem
          </span>
        </div>

        {/* ── Headline ─────────────────────────────────────────── */}
        <h2 className="font-sans font-[700] text-[clamp(1.75rem,4vw,2.75rem)] leading-[1.08] tracking-[-1.5px] mb-6 max-w-[40rem]">
          You&apos;re running AI agents{' '}
          <span className="text-gradient-orange">in 10 browser tabs.</span>
        </h2>
        <p className="text-[0.9375rem] text-[var(--landing-muted)] leading-[1.7] max-w-[32rem] mb-16">
          Checking if PRs landed. Re-running failed CI. Copy-pasting error logs into ChatGPT.
        </p>

        {/* ── Side-by-side Layout ──────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.1fr] gap-12 items-center">
          {/* Left — Explanation */}
          <div className="space-y-6">
            <p className="text-[0.9375rem] text-[var(--landing-fg-secondary)] leading-[1.85] max-w-[28rem]">
              Agent Orchestrator replaces that with one YAML file. Point it at
              your GitHub issues, pick your agents, and walk away. Each agent
              spawns in its own git worktree, creates PRs, fixes CI failures,
              addresses review comments, and moves toward merge.
            </p>

            <p className="text-[0.8125rem] text-[var(--landing-muted)] leading-[1.75]">
              If you&apos;re new, start with the{' '}
              <a
                href="/docs/"
                className="text-[var(--accent-orange)] underline underline-offset-4 decoration-[rgba(249,115,22,0.3)] hover:decoration-[var(--accent-orange)] transition-colors"
              >
                docs quickstart and configuration guides
              </a>.
            </p>

            {/* Feature pills */}
            <div className="flex flex-wrap gap-2 pt-4">
              {['Git Worktrees', 'Auto CI Fix', 'PR Reviews', 'Slack Alerts'].map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[0.6875rem] font-medium tracking-wide text-[var(--landing-muted)] border border-[var(--landing-border)] bg-[var(--surface-card)]"
                >
                  <span className="w-1 h-1 rounded-full bg-[var(--accent-green)]" />
                  {tag}
                </span>
              ))}
            </div>
          </div>

          {/* Right — Terminal Code Preview Card */}
          <div className="glow-card overflow-hidden">
            {/* Terminal title bar */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--landing-border)] bg-[rgba(255,255,255,0.015)]">
              <div className="flex items-center gap-2">
                <div className="w-[10px] h-[10px] rounded-full bg-[rgba(255,255,255,0.06)]" />
                <div className="w-[10px] h-[10px] rounded-full bg-[rgba(255,255,255,0.06)]" />
                <div className="w-[10px] h-[10px] rounded-full bg-[rgba(255,255,255,0.06)]" />
              </div>
              <span className="font-mono text-[0.5625rem] tracking-wider text-[var(--landing-muted-dim)]">
                agent-orchestrator.yaml
              </span>
              <div className="w-[38px]" />
            </div>

            {/* Code body */}
            <div className="px-6 py-5 font-mono text-[0.8125rem] leading-[2.1] overflow-x-auto">
              <code>
                <Line label="agent" value="claude-code" accent />
                <Line label="tracker" value="github" />
                <Line label="workspace" value="worktree" />
                <Line label="runtime" value="tmux" />
                <Line label="notifier" value="slack" />
                <span className="inline-block w-[7px] h-[15px] bg-[var(--accent-orange)] landing-cursor-blink align-middle ml-0.5" />
              </code>
            </div>

            {/* Subtle bottom accent line */}
            <div className="h-[1px] bg-gradient-to-r from-transparent via-[rgba(249,115,22,0.2)] to-transparent" />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── Helper: single YAML key‑value line ─────────────────────────── */
function Line({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <span className="block">
      <span className="text-[var(--landing-muted-dim)]">{label}:</span>{' '}
      <span className={accent ? 'text-[var(--accent-green)]' : 'text-[var(--landing-fg)]'}>
        {value}
      </span>
    </span>
  );
}
