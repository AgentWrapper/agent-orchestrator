"use client";

import { useEffect, useRef, useState } from "react";

const steps = [
  { label: "Issue assigned", mono: "#42", color: "rgba(255,240,220,0.5)" },
  { label: "Agent spawns", mono: "claude-code", color: "rgba(96,165,250,0.8)" },
  { label: "Worktree created", mono: "feat/auth", color: "rgba(234,179,8,0.7)" },
  { label: "PR opened", mono: "PR #312", color: "rgba(167,139,250,0.7)" },
  { label: "CI passes", mono: "✓ 48/48", color: "rgba(134,239,172,0.7)" },
  { label: "Merged", mono: "main", color: "rgba(34,197,94,0.9)" },
];

export function LandingWorkflow() {
  const [activeStep, setActiveStep] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const timerIds = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          const ids: ReturnType<typeof setTimeout>[] = [];
          steps.forEach((_, i) => {
            ids.push(setTimeout(() => setActiveStep(i), 600 + i * 700));
          });
          timerIds.current = ids;
        }
      },
      { threshold: 0.4 },
    );
    if (ref.current) observer.observe(ref.current);
    return () => {
      observer.disconnect();
      timerIds.current.forEach(clearTimeout);
    };
  }, []);

  return (
    <section ref={ref} className="py-[100px] px-6 max-w-[72rem] mx-auto">
      <div className="landing-reveal">
        <div className="text-xs tracking-[0.15em] uppercase text-[var(--landing-muted-dim)] mb-6 font-mono">
          Lifecycle
        </div>
        <h2 className="font-sans font-[680] text-[clamp(1.375rem,3vw,2rem)] leading-[1.1] tracking-[-1.5px] mb-16">
          From issue to merged PR
        </h2>
      </div>

      {/* Pipeline */}
      <div className="relative">
        {/* Connection line */}
        <div className="absolute top-6 left-6 right-6 h-px bg-[var(--landing-border-subtle)] hidden md:block" />
        <div
          className="absolute top-6 left-6 right-6 h-px hidden md:block transition-all duration-700 ease-out origin-left"
          style={{
            background: "var(--landing-accent)",
            transform: `scaleX(${activeStep >= 0 ? Math.min(activeStep / (steps.length - 1), 1) : 0})`,
          }}
        />

        {/* Steps */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-6 md:gap-0">
          {steps.map((step, i) => {
            const isActive = i <= activeStep;
            return (
              <div key={step.label} className="flex flex-col items-center text-center relative">
                {/* Node */}
                <div
                  className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 transition-all duration-500 ${
                    isActive
                      ? "landing-card border-[var(--landing-border-default)]"
                      : "border border-[var(--landing-border-subtle)] bg-transparent"
                  }`}
                  style={isActive ? { borderColor: step.color, boxShadow: `0 0 12px ${step.color.replace(/[\d.]+\)$/, "0.15)") }` } : undefined}
                >
                  <span
                    className={`w-2.5 h-2.5 rounded-full transition-all duration-500 ${
                      isActive ? "scale-100" : "scale-50 opacity-30"
                    }`}
                    style={{ backgroundColor: isActive ? step.color : "var(--landing-muted-dim)" }}
                  />
                </div>

                {/* Label */}
                <div
                  className={`text-[0.6875rem] font-medium mb-1 transition-all duration-500 ${
                    isActive ? "text-[var(--landing-fg)]" : "text-[var(--landing-muted-dim)]"
                  }`}
                >
                  {step.label}
                </div>
                <div
                  className={`font-mono text-[0.5625rem] transition-all duration-500 ${
                    isActive ? "text-[var(--landing-muted)]" : "text-[var(--landing-muted-dim)] opacity-50"
                  }`}
                >
                  {step.mono}
                </div>

                {/* Pulse on active */}
                {i === activeStep && (
                  <div
                    className="absolute top-0 w-12 h-12 rounded-xl landing-node-pulse"
                    style={{ borderColor: step.color }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
