"use client";

import { motion } from "motion/react";
import { GeistMono } from "geist/font/mono";
import { ArrowUpRight, Files, Globe, GitPullRequest } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { featurePreviewTokens, StatusDot } from "../FeaturePreviewShell";

const tone = {
  working: "#60a5fa",
  success: "#4ade80",
  danger: "oklch(0.704 0.191 22.216)",
  foreground: "var(--preview-foreground)",
  muted: "var(--preview-muted-foreground)",
} as const;

const phases = [
  {
    label: "CI failed",
    status: "Needs attention",
    color: tone.danger,
    check: "test / web",
    checkDetail: "AuthCallback rejects expired state",
    lines: [
      { kind: "system", text: "GitHub feedback routed from PR #2481" },
      { kind: "error", text: "test / web failed: expected 401, received 500" },
      { kind: "muted", text: "Failure logs attached. Resuming session…" },
    ],
  },
  {
    label: "Working",
    status: "Agent fixing",
    color: tone.working,
    check: "test / web",
    checkDetail: "Re-running after the next push",
    lines: [
      { kind: "prompt", text: "The expiry check runs after token exchange." },
      { kind: "action", text: "reading  src/auth/callback.ts" },
      { kind: "action", text: "editing  validate state before exchange" },
    ],
  },
  {
    label: "Working",
    status: "Verifying fix",
    color: tone.working,
    check: "Checks running",
    checkDetail: "Commit 91f8c2a pushed to feat/github-auth",
    lines: [
      { kind: "command", text: "npm test -- auth/callback" },
      { kind: "success", text: "12 tests passed" },
      { kind: "command", text: "git push origin feat/github-auth" },
    ],
  },
  {
    label: "In review",
    status: "Checks passed",
    color: tone.success,
    check: "10 / 10 checks",
    checkDetail: "Required checks passed",
    lines: [
      { kind: "success", text: "test / web" },
      { kind: "success", text: "typecheck" },
      { kind: "system", text: "PR #2481 returned to review" },
    ],
  },
] as const;

type Phase = (typeof phases)[number];
type TerminalLine = Phase["lines"][number];

export function FeedbackLoopDemo() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(
      () => setActive((value) => (value + 1) % phases.length),
      2500,
    );
    return () => window.clearInterval(interval);
  }, []);

  const phase = phases[active];

  return (
    <div
      className="mx-auto w-full min-w-0 max-w-[620px] overflow-hidden rounded-xl border border-[var(--preview-border)] bg-[var(--preview-background)] font-sans text-[var(--preview-foreground)] antialiased shadow-[0_28px_74px_-22px_rgba(0,0,0,0.86)]"
      style={featurePreviewTokens}
    >
      <div className="grid h-[330px] min-w-0 grid-cols-1 grid-rows-[minmax(0,1fr)_42px] sm:h-[370px] sm:grid-cols-[minmax(0,1fr)_208px] sm:grid-rows-1">
        <AgentPane active={active} phase={phase} />
        <Inspector active={active} phase={phase} onSelect={setActive} />
        <MobileActivity active={active} onSelect={setActive} />
      </div>
    </div>
  );
}

function AgentPane({ active, phase }: { active: number; phase: Phase }) {
  return (
    <main className="flex min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col bg-[#101317]">
        <motion.div
          key={active}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          className={`${GeistMono.className} space-y-2.5 p-4 text-[12px] leading-5 text-[#d7d7d2]`}
        >
          {phase.lines.map((line, index) => (
            <motion.div
              key={line.text}
              initial={{ opacity: 0, x: -3 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.12 }}
              className="flex items-start gap-2.5"
            >
              <span
                className="w-3 shrink-0 text-center font-semibold"
                style={{ color: lineColor(line) }}
              >
                {linePrefix(line)}
              </span>
              <span
                className="min-w-0 break-words"
                style={{ color: lineColor(line) }}
              >
                {line.text}
              </span>
            </motion.div>
          ))}
          {active === 1 ? (
            <div className="flex items-center gap-2 text-[#7c7c7c]">
              <span className="size-2 animate-spin rounded-full border border-current border-t-transparent" />
              working…
            </div>
          ) : null}
        </motion.div>
      </div>
    </main>
  );
}

function Inspector({
  active,
  phase,
  onSelect,
}: {
  active: number;
  phase: Phase;
  onSelect: (value: number) => void;
}) {
  return (
    <aside className="hidden min-w-0 overflow-hidden border-l border-[var(--preview-border)] bg-[var(--preview-card)]/25 sm:block">
      <div className="flex h-11 items-center gap-1 border-b border-[var(--preview-border)] px-2.5">
        <InspectorTab active label="Summary">
          <SummaryIcon />
        </InspectorTab>
        <InspectorTab label="Browser">
          <Globe className="size-3.5" />
        </InspectorTab>
        <InspectorTab label="Files">
          <Files className="size-3.5" />
        </InspectorTab>
      </div>
      <div className="space-y-2.5 p-2.5">
        <section>
          <div className="rounded-lg bg-[var(--preview-card)] px-3.5 py-3">
            <div className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.08em] text-[var(--preview-muted-foreground)]">
              Pull request
            </div>
            <div className="rounded-lg border border-[var(--preview-border)] bg-[var(--preview-background)]/45 px-2.5 py-2">
              <div className="flex items-center gap-2 text-[11.5px] font-semibold">
                <GitPullRequest className="size-3.5" />
                PR #2481
                <span className="ml-auto inline-flex items-center gap-0.5 text-[10.5px] text-blue-400">
                  Open <ArrowUpRight className="size-3" />
                </span>
              </div>
              <div className="mt-2.5 border-t border-[var(--preview-border)] pt-2.5">
                <div
                  className="flex items-center gap-1.5 text-[10.5px] font-medium"
                  style={{ color: phase.color }}
                >
                  <StatusDot color={phase.color} pulse={active === 2} />
                  {phase.check}
                </div>
                <div className="mt-1.5 text-[10px] leading-[1.45] text-[var(--preview-muted-foreground)]">
                  {phase.checkDetail}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div className="rounded-lg bg-[var(--preview-card)] px-3.5 py-3">
            <div className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.08em] text-[var(--preview-muted-foreground)]">
              Activity
            </div>
            <div className="space-y-0">
              {phases.map((item, index) => (
                <button
                  type="button"
                  key={item.status}
                  onClick={() => onSelect(index)}
                  className="relative flex w-full items-start gap-2.5 pb-2.5 text-left last:pb-0"
                >
                  {index < phases.length - 1 ? (
                    <span className="absolute left-[3px] top-2 h-[calc(100%-4px)] w-px bg-[var(--preview-border)]" />
                  ) : null}
                  <span
                    className="relative mt-1 size-2 shrink-0 rounded-full"
                    style={{
                      background:
                        index <= active
                          ? item.color
                          : "var(--preview-muted-foreground)",
                    }}
                  />
                  <span className="min-w-0">
                    <span
                      className="block text-[10.5px] font-medium"
                      style={{
                        color: index === active ? item.color : tone.muted,
                      }}
                    >
                      {item.status}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </aside>
  );
}

function InspectorTab({
  active = false,
  children,
  label,
}: {
  active?: boolean;
  children: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className={`grid size-7 place-items-center rounded-md ${
        active
          ? "bg-[var(--preview-muted)] text-[var(--preview-foreground)]"
          : "text-[var(--preview-muted-foreground)]"
      }`}
    >
      {children}
    </button>
  );
}

function SummaryIcon() {
  return (
    <svg
      className="size-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <line x1="8" y1="7" x2="20" y2="7" />
      <line x1="8" y1="12" x2="20" y2="12" />
      <line x1="8" y1="17" x2="16" y2="17" />
      <circle cx="4" cy="7" r="1" />
      <circle cx="4" cy="12" r="1" />
      <circle cx="4" cy="17" r="1" />
    </svg>
  );
}

function MobileActivity({
  active,
  onSelect,
}: {
  active: number;
  onSelect: (value: number) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 border-t border-[var(--preview-border)] bg-[var(--preview-card)]/35 px-3 sm:hidden">
      <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--preview-muted-foreground)]">
        Activity
      </span>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
        {phases.map((item, index) => (
          <button
            type="button"
            key={item.status}
            onClick={() => onSelect(index)}
            aria-label={item.status}
            className="grid size-6 shrink-0 place-items-center rounded-md"
          >
            <span
              className="size-2 rounded-full"
              style={{ background: index <= active ? item.color : tone.muted }}
            />
          </button>
        ))}
      </div>
      <span
        className="min-w-0 max-w-[94px] truncate text-[10.5px] font-medium"
        style={{ color: phases[active].color }}
      >
        {phases[active].status}
      </span>
    </div>
  );
}

function lineColor(line: TerminalLine): string {
  switch (line.kind) {
    case "error":
      return tone.danger;
    case "success":
      return tone.success;
    case "action":
      return tone.working;
    case "muted":
      return tone.muted;
    default:
      return tone.foreground;
  }
}

function linePrefix(line: TerminalLine): string {
  switch (line.kind) {
    case "error":
      return "×";
    case "success":
      return "✓";
    case "action":
      return "●";
    case "prompt":
      return "❯";
    case "command":
      return "$";
    default:
      return "";
  }
}
