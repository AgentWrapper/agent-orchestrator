"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { GitHubRepoStats } from "@/lib/github-repo";

interface LandingStatsProps {
  stats: GitHubRepoStats;
}

/* ── Animated counter hook ──────────────────────────────────── */
function useAnimatedCounter(
  target: number,
  duration = 1800,
  enabled = true,
) {
  const [value, setValue] = useState(enabled ? 0 : target);
  const raf = useRef<number>(0);

  useEffect(() => {
    if (!enabled) return;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(eased * target));
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, duration, enabled]);

  return value;
}

/* ── Stat card ──────────────────────────────────────────────── */
function StatCard({
  raw,
  label,
  icon,
  delay,
  visible,
}: {
  raw: number;
  label: string;
  icon: React.ReactNode;
  delay: number;
  visible: boolean;
}) {
  const display = useAnimatedCounter(raw, 2000, visible);
  const formatted = display.toLocaleString();

  return (
    <div
      className="landing-card glow-card group relative flex flex-col items-center justify-center rounded-2xl py-9 px-5
                 transition-all duration-500 ease-out
                 hover:scale-[1.04] hover:shadow-[0_0_40px_rgba(249,115,22,0.08)]"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(24px)",
        transitionDelay: `${delay}ms`,
      }}
    >
      {/* Icon */}
      <span className="mb-3 text-[var(--landing-muted)] opacity-50 transition-opacity duration-300 group-hover:opacity-90">
        {icon}
      </span>

      {/* Number — gradient text */}
      <span
        className="font-sans font-[800] leading-none tracking-tight
                   text-[clamp(2.25rem,4.5vw,3.5rem)]"
        style={{
          background:
            "linear-gradient(135deg, var(--landing-fg) 30%, var(--accent-orange) 100%)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          backgroundClip: "text",
        }}
      >
        {formatted}
      </span>

      {/* Label */}
      <span
        className="mt-2 text-[0.8rem] font-medium tracking-wide uppercase"
        style={{ color: "var(--landing-muted)" }}
      >
        {label}
      </span>

      {/* Subtle border glow on hover */}
      <div
        className="pointer-events-none absolute inset-0 rounded-2xl opacity-0 transition-opacity duration-500 group-hover:opacity-100"
        style={{
          background:
            "linear-gradient(135deg, rgba(249,115,22,0.06) 0%, transparent 60%)",
        }}
      />
    </div>
  );
}

/* ── Main section ───────────────────────────────────────────── */
export function LandingStats({ stats }: LandingStatsProps) {
  const sectionRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  const observerCallback = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      if (entries[0]?.isIntersecting) setVisible(true);
    },
    [],
  );

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(observerCallback, {
      threshold: 0.2,
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [observerCallback]);

  const cards: {
    raw: number;
    label: string;
    icon: React.ReactNode;
  }[] = [
    {
      raw: stats.stars,
      label: "GitHub Stars",
      icon: <StarIcon />,
    },
    {
      raw: stats.forks,
      label: "Forks",
      icon: <ForkIcon />,
    },
    {
      raw: stats.openIssues,
      label: "Open Issues",
      icon: <IssueIcon />,
    },
    {
      raw: stats.watchers,
      label: "Watchers",
      icon: <EyeIcon />,
    },
  ];

  return (
    <section ref={sectionRef} className="py-20 px-6 max-w-[72rem] mx-auto">
      {/* ── Stat cards grid ── */}
      <div className="landing-reveal grid grid-cols-2 md:grid-cols-4 gap-5">
        {cards.map((stat, i) => (
          <StatCard
            key={stat.label}
            raw={stat.raw}
            label={stat.label}
            icon={stat.icon}
            delay={i * 120}
            visible={visible}
          />
        ))}
      </div>

      {/* ── Bottom badges ── */}
      <div
        className="landing-reveal mt-10 flex flex-col sm:flex-row items-center justify-center gap-4"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? "translateY(0)" : "translateY(16px)",
          transition: "opacity 0.6s ease, transform 0.6s ease",
          transitionDelay: "600ms",
        }}
      >
        {/* GitHub stars link */}
        <a
          href="https://github.com/ComposioHQ/agent-orchestrator"
          target="_blank"
          rel="noopener noreferrer"
          className="landing-card inline-flex items-center gap-2.5 rounded-xl px-5 py-2.5
                     text-[0.8125rem] no-underline transition-all duration-300
                     hover:scale-[1.03] hover:shadow-[0_0_24px_rgba(249,115,22,0.12)]"
          style={{
            color: "var(--landing-muted)",
            border: "1px solid var(--landing-border)",
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="currentColor"
            style={{ color: "var(--landing-fg)", opacity: 0.7 }}
          >
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          <span
            className="font-mono text-xs font-semibold"
            style={{ color: "var(--landing-fg)", opacity: 0.9 }}
          >
            {stats.stars.toLocaleString()}
          </span>
          <span>stars on GitHub</span>
        </a>

        {/* Built with itself badge */}
        <div
          className="landing-card inline-flex items-center gap-2.5 rounded-xl px-5 py-2.5
                     text-[0.8125rem] transition-all duration-300"
          style={{
            color: "var(--landing-muted)",
            border: "1px solid var(--landing-border)",
          }}
        >
          <span className="relative flex h-2 w-2">
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
              style={{ backgroundColor: "var(--accent-green)" }}
            />
            <span
              className="relative inline-flex h-2 w-2 rounded-full"
              style={{ backgroundColor: "var(--accent-green)" }}
            />
          </span>
          <span>
            Built with itself — this repo is managed by Agent&nbsp;Orchestrator
          </span>
        </div>
      </div>
    </section>
  );
}

/* ── Inline SVG icons ───────────────────────────────────────── */
function StarIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function ForkIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
      <path d="M12 12v3" />
    </svg>
  );
}

function IssueIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
