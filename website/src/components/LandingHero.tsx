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
    <div ref={ref} className="px-6 py-5 font-mono text-[0.8125rem] leading-[2] text-left min-h-[280px]">
      {terminalLines.slice(0, visibleCount).map((line, i) => {
        if (line.type === "blank") return <div key={i}>&nbsp;</div>;

        const colorClass =
          line.type === "cmd"
            ? "text-[var(--landing-fg)]"
            : line.type === "success"
              ? "text-[var(--accent-green)]"
              : line.type === "status"
                ? "text-[var(--landing-fg-secondary)]"
                : "text-[var(--landing-muted)]";

        return (
          <div
            key={i}
            className={`${colorClass} landing-line-appear`}
          >
            {line.type === "cmd" && (
              <span className="text-[var(--accent-orange)] mr-1">$</span>
            )}
            {line.type === "status" && (
              <span className="landing-pulse-dot mr-1.5 inline-block w-1.5 h-1.5 rounded-full bg-[var(--accent-green)]" />
            )}
            {line.type === "success" && (
              <span className="text-[var(--accent-green)] mr-1">✓</span>
            )}
            {line.type === "cmd" ? line.text.slice(2) : line.type === "status" ? line.text.slice(2) : line.type === "success" ? line.text.slice(2) : line.text}
          </div>
        );
      })}
      {visibleCount > 0 && visibleCount < terminalLines.length && (
        <span className="inline-block w-2 h-4 bg-[var(--accent-orange)] landing-cursor-blink" />
      )}
    </div>
  );
}

export function LandingHero({ starsLabel }: LandingHeroProps) {
  return (
    <div className="relative min-h-screen overflow-hidden flex items-center justify-center">
      {/* Animated mesh gradient background */}
      <div className="mesh-gradient">
        <div className="orb orb-1" />
        <div className="orb orb-2" />
        <div className="orb orb-3" />
      </div>

      {/* Grid pattern overlay */}
      <div className="absolute inset-0 grid-pattern z-[1]" />

      {/* Radial vignette */}
      <div className="absolute inset-0 z-[2]" style={{
        background: "radial-gradient(ellipse 80% 60% at 50% 40%, transparent 0%, var(--landing-bg) 70%)"
      }} />

      <section className="relative z-10 flex flex-col items-center justify-center text-center px-6 pt-28 pb-16 min-h-screen max-w-[72rem] mx-auto">
        {/* Badge */}
        <div className="landing-fade-up landing-card inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs mb-8" style={{
          background: "rgba(249,115,22,0.08)",
          borderColor: "rgba(249,115,22,0.2)"
        }}>
          <span className="landing-pulse-dot w-2 h-2 rounded-full bg-[var(--accent-green)]" />
          <span className="text-[var(--landing-fg-secondary)]">
            Open Source · MIT ·{" "}
            <span className="text-[var(--accent-orange)] font-semibold">{starsLabel}</span> GitHub Stars
          </span>
        </div>

        {/* Main heading */}
        <h1 className="landing-fade-up-d1 text-[clamp(2.5rem,6vw,4.5rem)] leading-[1.05] tracking-[-2.5px] max-w-[56rem] font-bold">
          Run 30 AI agents
          <br />
          <span className="text-gradient-orange">in parallel.</span>
          <br />
          <span className="text-[var(--landing-muted)]">One dashboard.</span>
        </h1>

        {/* Subtitle */}
        <p className="landing-fade-up-d2 text-[var(--landing-muted)] text-[1.0625rem] max-w-[40rem] mt-7 leading-[1.75]">
          Agent Orchestrator spawns Claude Code, Codex, Cursor, Aider &amp; OpenCode
          in isolated git worktrees. Each agent gets its own branch, creates PRs,
          fixes CI, and addresses reviews — <span className="text-[var(--landing-fg-secondary)] font-medium">autonomously</span>.
        </p>

        {/* CTA buttons */}
        <div className="landing-fade-up-d3 flex items-center gap-3 mt-10 flex-wrap justify-center">
          <div className="landing-card rounded-xl px-6 py-3.5 font-mono text-sm flex items-center gap-2" style={{
            background: "rgba(0,0,0,0.4)",
            backdropFilter: "blur(10px)"
          }}>
            <span className="text-[var(--accent-orange)]">$</span>
            <span>npx @aoagents/ao start</span>
          </div>
          <a href="/docs" className="btn-primary">
            Get Started →
          </a>
          <a
            href="https://github.com/ComposioHQ/agent-orchestrator"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            GitHub
          </a>
        </div>

        {/* Terminal demo */}
        <div className="landing-fade-up-d4 w-full max-w-[56rem] mt-16">
          <div className="landing-card rounded-2xl overflow-hidden" style={{
            background: "rgba(0,0,0,0.5)",
            backdropFilter: "blur(20px)",
            boxShadow: "0 0 60px -15px rgba(249,115,22,0.1), 0 0 120px -30px rgba(139,92,246,0.08)"
          }}>
            {/* Terminal header */}
            <div className="flex items-center gap-3 px-5 py-3.5 border-b" style={{ borderColor: "var(--landing-border)" }}>
              <div className="flex gap-2">
                <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
                <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
                <div className="w-3 h-3 rounded-full bg-[#28c840]" />
              </div>
              <span className="font-mono text-[0.6875rem] text-[var(--landing-muted)] opacity-60">
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
