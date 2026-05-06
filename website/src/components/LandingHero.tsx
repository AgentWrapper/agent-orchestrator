"use client";

import { useEffect, useRef, useState } from "react";

interface LandingHeroProps {
  starsLabel: string;
}

const terminalLines = [
  { text: "$ ao batch-spawn 42 43 44 45 46", type: "cmd" as const, delay: 0 },
  { text: "", type: "blank" as const, delay: 800 },
  { text: "⟡ Loaded agent-orchestrator.yaml (agent: claude-code, tracker: github)", type: "info" as const, delay: 1000 },
  { text: "⟡ Resolving 5 issues from ComposioHQ/my-saas-app", type: "info" as const, delay: 1400 },
  { text: "⟡ Creating worktrees in ~/.agent-orchestrator/a1b2c3/worktrees/", type: "info" as const, delay: 1800 },
  { text: "", type: "blank" as const, delay: 2200 },
  { text: "✓ s-001 → #42 Add user auth flow (claude-code)", type: "success" as const, delay: 2400 },
  { text: "✓ s-002 → #43 Fix pagination bug (codex)", type: "success" as const, delay: 2700 },
  { text: "✓ s-003 → #44 Add rate limiting (aider)", type: "success" as const, delay: 3000 },
  { text: "✓ s-004 → #45 Update API tests (claude-code)", type: "success" as const, delay: 3300 },
  { text: "✓ s-005 → #46 Refactor DB layer (opencode)", type: "success" as const, delay: 3600 },
  { text: "", type: "blank" as const, delay: 4000 },
  { text: "● 5 agents working · Dashboard → http://localhost:3000", type: "status" as const, delay: 4200 },
];

function TerminalTyping() {
  const [visibleCount, setVisibleCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const timerIds = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          const ids: ReturnType<typeof setTimeout>[] = [];
          terminalLines.forEach((line, i) => {
            ids.push(setTimeout(() => setVisibleCount(i + 1), line.delay));
          });
          timerIds.current = ids;
        }
      },
      { threshold: 0.3 },
    );
    if (ref.current) observer.observe(ref.current);
    return () => {
      observer.disconnect();
      timerIds.current.forEach(clearTimeout);
    };
  }, []);

  return (
    <div ref={ref} className="px-5 py-4 font-mono text-[0.8125rem] leading-[1.9] text-left min-h-[280px]">
      {terminalLines.slice(0, visibleCount).map((line, i) => {
        if (line.type === "blank") return <div key={i}>&nbsp;</div>;

        const colorClass =
          line.type === "cmd"
            ? "text-[var(--landing-fg)]"
            : line.type === "success"
              ? "text-[rgba(134,239,172,0.8)]"
              : line.type === "status"
                ? "text-[var(--landing-muted)]"
                : "text-[var(--landing-muted)] opacity-50";

        return (
          <div
            key={i}
            className={`${colorClass} landing-line-appear`}
          >
            {line.type === "cmd" && (
              <span className="text-[var(--landing-muted)] opacity-50">$ </span>
            )}
            {line.type === "status" && (
              <span className="landing-agent-dot mr-1.5 inline-block" />
            )}
            {line.type === "cmd" ? line.text.slice(2) : line.type === "status" ? line.text.slice(2) : line.text}
          </div>
        );
      })}
      {visibleCount > 0 && visibleCount < terminalLines.length && (
        <span className="inline-block w-2 h-4 bg-[var(--landing-fg)] opacity-70 landing-cursor-blink" />
      )}
    </div>
  );
}

export function LandingHero({ starsLabel }: LandingHeroProps) {
  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="absolute inset-0 z-[1] landing-hero-grid" />
      <section className="relative z-10 flex flex-col items-center justify-center text-center px-6 pt-32 pb-20 min-h-screen">
        <div className="landing-fade-rise landing-card inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs text-[var(--landing-muted)] mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-[rgba(134,239,172,0.7)]" />
          Open Source · MIT Licensed · {starsLabel} GitHub Stars
        </div>
        <h1 className="landing-fade-rise font-sans font-[680] text-[clamp(1.75rem,4vw,2.75rem)] leading-[1] tracking-[-2px] max-w-[56rem]">
          Run 30 AI agents in parallel.
          <br />
          <span className="text-[var(--landing-muted)]">One dashboard.</span>
        </h1>
        <p className="landing-fade-rise-d1 text-[var(--landing-muted)] text-[0.9375rem] max-w-[38rem] mt-6 leading-[1.7]">
          Agent Orchestrator spawns Claude Code, Codex, Cursor, Aider, and OpenCode
          in isolated git worktrees. Each agent gets its own branch, creates PRs,
          fixes CI, and addresses reviews autonomously.
        </p>
        <div className="landing-fade-rise-d2 flex items-center gap-3 mt-10 flex-wrap justify-center">
          <div className="landing-card rounded-lg px-6 py-3 font-mono text-sm">
            <span className="text-[var(--landing-muted)] opacity-40">$</span> npx @aoagents/ao start
          </div>
          <a
            href="/docs"
            className="landing-card rounded-lg px-6 py-3 text-sm no-underline transition-colors hover:text-white"
          >
            Read Docs
          </a>
          <a
            href="https://github.com/ComposioHQ/agent-orchestrator"
            target="_blank"
            rel="noopener noreferrer"
            className="liquid-glass-solid rounded-lg px-6 py-3 text-sm no-underline transition-colors"
          >
            View on GitHub
          </a>
        </div>

        <div className="landing-fade-rise-d2 w-full max-w-[52rem] mt-16">
          <div className="landing-card rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--landing-border-subtle)]">
              <div className="w-2.5 h-2.5 rounded-full bg-[rgba(255,240,220,0.08)]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[rgba(255,240,220,0.08)]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[rgba(255,240,220,0.08)]" />
              <span className="ml-2 font-mono text-[0.625rem] text-[var(--landing-muted)] opacity-40">
                agent-orchestrator — my-saas-app
              </span>
            </div>
            <TerminalTyping />
          </div>
        </div>
      </section>
    </div>
  );
}
