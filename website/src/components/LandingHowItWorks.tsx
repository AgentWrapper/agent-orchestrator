"use client";

import { useEffect, useRef, useState } from "react";

const stepDetails = [
  {
    num: "01",
    title: "Configure &",
    titleItalic: "assign",
    desc: "Point Agent Orchestrator at your repo with a YAML config. Choose your agent, set up trackers and notifiers. One file, full control.",
    code: `# agent-orchestrator.yaml
agent: claude-code
tracker: github
workspace: worktree
runtime: tmux
notifier: slack`,
    accent: "var(--accent-orange)",
  },
  {
    num: "02",
    title: "Agents",
    titleItalic: "work",
    desc: "Each agent clones into a git worktree, reads the issue, plans, writes code, runs tests, and opens a PR — all autonomously.",
    code: `$ ao spawn 42
⟡ Spawning claude-code for #42
⟡ Worktree: .ao/worktrees/feat-auth
⟡ Agent reading issue... writing code...
✓ PR #312 opened → feat/auth-flow`,
    accent: "var(--accent-blue)",
  },
  {
    num: "03",
    title: "PRs",
    titleItalic: "land",
    desc: "Agents handle CI failures, address review comments, and keep pushing until merge. You just review and approve.",
    code: `✓ CI passing (48/48 tests)
✓ Review comments addressed
✓ Branch up-to-date with main
✓ Ready for merge
→ Merged into main`,
    accent: "var(--accent-green)",
  },
];

export function LandingHowItWorks() {
  return (
    <section className="py-[140px] px-6 max-w-[72rem] mx-auto" id="how">
      <div className="landing-reveal">
        <div className="font-mono text-[0.75rem] tracking-[0.2em] uppercase text-[var(--accent-cyan)] mb-4">
          Process
        </div>
        <h2 className="text-[clamp(1.5rem,3vw,2.25rem)] leading-[1.1] tracking-[-1px] font-bold">
          Three steps to{" "}
          <span className="text-gradient-purple">orchestration</span>
        </h2>
      </div>

      <div className="flex flex-col gap-6 mt-16">
        {stepDetails.map((step) => (
          <StepCard key={step.num} step={step} />
        ))}
      </div>
    </section>
  );
}

function StepCard({ step }: { step: typeof stepDetails[0] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.2 }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`glow-card p-8 md:p-10 transition-all duration-700 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
      }`}
      style={{ transitionDelay: "0.1s" }}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-10 items-start">
        {/* Text */}
        <div>
          <div className="flex items-center gap-3 mb-5">
            <span className="font-mono text-[0.75rem] px-2.5 py-1 rounded-md" style={{
              background: `color-mix(in srgb, ${step.accent} 10%, transparent)`,
              color: step.accent,
            }}>
              {step.num}
            </span>
          </div>
          <h3 className="text-2xl font-bold tracking-tight mb-4">
            {step.title}
            <span className="text-[var(--landing-muted)] italic"> {step.titleItalic}</span>
          </h3>
          <p className="text-[var(--landing-muted)] text-[0.9375rem] leading-[1.8]">
            {step.desc}
          </p>
        </div>

        {/* Code preview */}
        <div className="rounded-xl overflow-hidden" style={{
          background: "rgba(0,0,0,0.4)",
          border: "1px solid var(--landing-border)",
        }}>
          <div className="flex items-center gap-2 px-4 py-2.5" style={{
            borderBottom: "1px solid var(--landing-border)"
          }}>
            <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
          </div>
          <pre className="px-5 py-4 font-mono text-[0.75rem] leading-[2] text-[var(--landing-muted)] overflow-x-auto">
            {step.code.split("\n").map((line, i) => (
              <div key={i} className={line.startsWith("✓") ? "text-[var(--accent-green)]" : line.startsWith("$") ? "text-[var(--landing-fg-secondary)]" : line.startsWith("→") ? "text-[var(--accent-orange)]" : ""}>
                {line || "\u00A0"}
              </div>
            ))}
          </pre>
        </div>
      </div>
    </div>
  );
}
