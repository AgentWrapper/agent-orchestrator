"use client";

import { useEffect, useRef, useState } from "react";

const steps = [
  { label: "Issue assigned", mono: "#42", color: "var(--accent-orange)" },
  { label: "Agent spawns", mono: "claude-code", color: "var(--accent-blue)" },
  { label: "Worktree created", mono: "feat/auth", color: "var(--accent-purple)" },
  { label: "PR opened", mono: "PR #312", color: "var(--accent-cyan)" },
  { label: "CI passes", mono: "✓ 48/48", color: "var(--accent-green)" },
  { label: "Merged", mono: "main", color: "var(--accent-green)" },
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
    <section ref={ref} className="py-[140px] px-6 max-w-[72rem] mx-auto">
      <div className="landing-reveal">
        <div className="font-mono text-[0.75rem] tracking-[0.2em] uppercase text-[var(--accent-purple)] mb-4">
          Lifecycle
        </div>
        <h2 className="text-[clamp(1.5rem,3vw,2.25rem)] leading-[1.1] tracking-[-1px] font-bold">
          From issue to merged PR
        </h2>
      </div>

      {/* Pipeline */}
      <div className="relative mt-16">
        {/* Connection line — background */}
        <div className="absolute top-6 left-6 right-6 h-[2px] hidden md:block" style={{
          background: "var(--landing-border)"
        }} />
        {/* Connection line — animated fill */}
        <div
          className="absolute top-6 left-6 right-6 h-[2px] hidden md:block transition-all duration-700 ease-out origin-left"
          style={{
            background: "linear-gradient(90deg, var(--accent-orange), var(--accent-purple), var(--accent-green))",
            transform: `scaleX(${activeStep >= 0 ? Math.min(activeStep / (steps.length - 1), 1) : 0})`,
          }}
        />

        {/* Steps */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-8 md:gap-0">
          {steps.map((step, i) => {
            const isActive = i <= activeStep;
            return (
              <div key={step.label} className="flex flex-col items-center text-center relative">
                {/* Node */}
                <div
                  className={`w-12 h-12 rounded-2xl flex items-center justify-center mb-4 transition-all duration-500 ${
                    isActive
                      ? "border-[1.5px]"
                      : "border border-[var(--landing-border)]"
                  }`}
                  style={isActive ? {
                    borderColor: step.color,
                    background: `color-mix(in srgb, ${step.color} 8%, transparent)`,
                    boxShadow: `0 0 20px -4px ${step.color}`
                  } : undefined}
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
                  className={`text-[0.75rem] font-medium mb-1 transition-all duration-500 ${
                    isActive ? "text-[var(--landing-fg)]" : "text-[var(--landing-muted-dim)]"
                  }`}
                >
                  {step.label}
                </div>
                <div
                  className={`font-mono text-[0.625rem] transition-all duration-500 ${
                    isActive ? "text-[var(--landing-muted)]" : "text-[var(--landing-muted-dim)] opacity-50"
                  }`}
                >
                  {step.mono}
                </div>

                {/* Pulse ring on active */}
                {i === activeStep && (
                  <div
                    className="absolute top-0 w-12 h-12 rounded-2xl landing-node-pulse"
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
