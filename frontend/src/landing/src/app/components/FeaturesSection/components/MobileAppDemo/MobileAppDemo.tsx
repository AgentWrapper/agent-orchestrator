"use client";

import { AnimatePresence, motion } from "motion/react";
import {
  GitBranch,
  GitPullRequest,
  Grid2X2,
  Plus,
  Settings,
  Share2,
  Terminal,
} from "lucide-react";
import { useMemo, useState } from "react";

const mobileTheme = {
  bgBase: "#0a0b0d",
  bgSurface: "#121317",
  bgElevated: "#15171b",
  bgElevatedHover: "#191b20",
  textPrimary: "#f4f5f7",
  textSecondary: "#9ba1aa",
  textTertiary: "#646a73",
  textFaint: "#444951",
  borderSubtle: "rgba(255,255,255,0.06)",
  borderDefault: "rgba(255,255,255,0.10)",
  blue: "#4d8dff",
  orange: "#f59f4c",
  amber: "#e8c14a",
  green: "#74b98a",
} as const;

/**
 * Design size of the phone. The frame is rendered at exactly this size on every
 * breakpoint and scaled to fit its slot, so the scale factors below are just
 * (slot height / PHONE_HEIGHT): 280/390 and 360/390.
 */
const PHONE_HEIGHT = 390;
const PHONE_WIDTH = Math.round(PHONE_HEIGHT * 0.48);

type Project = "All" | "agent-orchestrator-mo" | "meetyou" | "adorable";
type Tab = "Kanban" | "Orchestrator" | "PRs" | "Settings";

type Session = {
  id: number;
  project: Exclude<Project, "All">;
  title: string;
  branch: string;
  status: string;
  color: string;
  section: "Needs you" | "Working" | "Done";
};

const sessions: Session[] = [
  {
    id: 6,
    project: "meetyou",
    title: "fix-pin-unpin",
    branch: "ao/meetyou-6/root",
    status: "Needs input",
    color: mobileTheme.amber,
    section: "Needs you",
  },
  {
    id: 5,
    project: "meetyou",
    title: "local-test-both-prs",
    branch: "ao/meetyou-5/root",
    status: "Working",
    color: mobileTheme.orange,
    section: "Working",
  },
  {
    id: 2,
    project: "adorable",
    title: "adorable-2",
    branch: "ao/adorable-2/root",
    status: "Terminated",
    color: mobileTheme.textFaint,
    section: "Done",
  },
];

const projects: Project[] = [
  "All",
  "agent-orchestrator-mo",
  "meetyou",
  "adorable",
];

const tabs: {
  label: Tab;
  icon: typeof Grid2X2;
}[] = [
  { label: "Kanban", icon: Grid2X2 },
  { label: "Orchestrator", icon: Share2 },
  { label: "PRs", icon: GitPullRequest },
  { label: "Settings", icon: Settings },
];

export function MobileAppDemo() {
  const [project, setProject] = useState<Project>("All");
  const [tab, setTab] = useState<Tab>("Kanban");
  const [selectedSession, setSelectedSession] = useState<number | null>(null);

  const visibleSessions = useMemo(
    () =>
      project === "All"
        ? sessions
        : sessions.filter((session) => session.project === project),
    [project],
  );

  return (
    <div className="flex h-[280px] w-full items-center justify-center sm:h-[360px] lg:h-[390px]">
      {/*
        The screen is authored at one fixed size (PHONE_WIDTH x PHONE_HEIGHT) because
        everything inside it is absolute — 5px labels, a 28px status bar, a 44px tab bar.
        Resizing the frame per breakpoint would leave those at 100% and overflow the
        narrower screen, so scale the whole phone instead and keep its proportions.
      */}
      <div
        className="shrink-0 origin-center scale-[0.718] sm:scale-[0.923] lg:scale-100"
        style={{ width: PHONE_WIDTH, height: PHONE_HEIGHT }}
      >
        <div
          className="relative h-full w-full overflow-hidden rounded-[32px] border-[3px] border-[#30333a] bg-[#050608] p-[5px] shadow-[0_28px_60px_rgba(0,0,0,0.55)]"
          style={{ color: mobileTheme.textPrimary }}
        >
          <div
            className="relative flex h-full flex-col overflow-hidden rounded-[25px] font-sans antialiased"
            style={{ backgroundColor: mobileTheme.bgBase }}
          >
            <PhoneStatusBar />

            <AnimatePresence initial={false} mode="wait">
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -5, filter: "blur(3px)" }}
                transition={{
                  type: "spring",
                  duration: 0.3,
                  bounce: 0,
                }}
                className="min-h-0 flex-1 overflow-hidden"
              >
                {tab === "Kanban" ? (
                  <KanbanScreen
                    project={project}
                    visibleSessions={visibleSessions}
                    selectedSession={selectedSession}
                    onProjectChange={setProject}
                    onSelectSession={setSelectedSession}
                  />
                ) : (
                  <SecondaryScreen tab={tab} />
                )}
              </motion.div>
            </AnimatePresence>

            <BottomTabs activeTab={tab} onTabChange={setTab} />
          </div>
        </div>
      </div>
    </div>
  );
}

function PhoneStatusBar() {
  return (
    <div className="relative flex h-7 shrink-0 items-center justify-between px-5 pt-1">
      <span className="font-mono text-[6px] font-semibold tabular-nums">
        7:56
      </span>
      <span className="absolute left-1/2 top-1 h-3 w-14 -translate-x-1/2 rounded-full bg-black" />
      <div className="flex items-center gap-1" aria-hidden="true">
        <span className="flex gap-[1px]">
          <i className="size-[2px] rounded-full bg-white/30" />
          <i className="size-[2px] rounded-full bg-white/50" />
          <i className="size-[2px] rounded-full bg-white/80" />
        </span>
        <span className="h-2 w-3 rounded-[2px] border border-white/50 p-px">
          <i className="block h-full w-full rounded-[1px] bg-white" />
        </span>
      </div>
    </div>
  );
}

function KanbanScreen({
  onProjectChange,
  onSelectSession,
  project,
  selectedSession,
  visibleSessions,
}: {
  onProjectChange: (project: Project) => void;
  onSelectSession: (id: number) => void;
  project: Project;
  selectedSession: number | null;
  visibleSessions: Session[];
}) {
  const counts = {
    working: visibleSessions.filter((session) => session.section === "Working")
      .length,
    needsYou: visibleSessions.filter(
      (session) => session.section === "Needs you",
    ).length,
    mergeable: 0,
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between px-2.5 pb-2 pt-1">
        <div>
          <div className="flex items-center gap-1.5">
            <h4 className="text-[13px] font-extrabold tracking-[-0.4px]">
              Kanban
            </h4>
            <img src="/ao-logo.svg" alt="" className="size-3" />
          </div>
          <p
            className="mt-0.5 font-mono text-[5px]"
            style={{ color: mobileTheme.textTertiary }}
          >
            192.168.88.3
          </p>
        </div>
        <div
          className="mt-1 flex items-center gap-1 text-[5px] font-semibold"
          style={{ color: mobileTheme.textTertiary }}
        >
          <span
            className="size-1.5 rounded-full"
            style={{ backgroundColor: mobileTheme.green }}
          />
          live
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1 px-2.5">
        <Stat value={counts.working} label="working" color={mobileTheme.orange} />
        <Stat value={counts.needsYou} label="need you" color={mobileTheme.amber} />
        <Stat
          value={counts.mergeable}
          label="mergeable"
          color={mobileTheme.green}
        />
      </div>

      <div className="mt-2 flex shrink-0 gap-1 overflow-hidden px-2.5 pb-1">
        {projects.map((item) => {
          const active = item === project;
          return (
            <button
              key={item}
              type="button"
              onClick={() => onProjectChange(item)}
              className="min-h-5 shrink-0 rounded-full border px-2 text-[5px] font-semibold outline-none transition-[background-color,border-color,color,scale] duration-150 active:scale-[0.96] focus-visible:ring-1"
              style={{
                backgroundColor: active
                  ? "rgba(77,141,255,0.14)"
                  : mobileTheme.bgElevated,
                borderColor: active
                  ? mobileTheme.blue
                  : mobileTheme.borderDefault,
                color: active ? mobileTheme.blue : mobileTheme.textSecondary,
              }}
            >
              {item}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden pb-7">
        {(["Needs you", "Working", "Done"] as const).map((section) => {
          const sectionSessions = visibleSessions.filter(
            (session) => session.section === section,
          );
          if (sectionSessions.length === 0) return null;

          const color =
            section === "Needs you"
              ? mobileTheme.amber
              : section === "Working"
                ? mobileTheme.orange
                : mobileTheme.textTertiary;

          return (
            <section key={section}>
              <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2">
                <span
                  className="h-2.5 w-[2px] rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span
                  className="flex-1 text-[5px] font-bold uppercase tracking-[0.9px]"
                  style={{ color: mobileTheme.textSecondary }}
                >
                  {section}
                </span>
                <span
                  className="font-mono text-[5px] font-bold tabular-nums"
                  style={{ color: mobileTheme.textTertiary }}
                >
                  {sectionSessions.length}
                </span>
              </div>
              {sectionSessions.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  selected={selectedSession === session.id}
                  onClick={() => onSelectSession(session.id)}
                />
              ))}
            </section>
          );
        })}
      </div>

      <button
        type="button"
        aria-label="New agent"
        className="absolute bottom-3 right-3 grid size-7 place-items-center rounded-full shadow-lg outline-none transition-transform duration-150 active:scale-[0.96] focus-visible:ring-2"
        style={{
          backgroundColor: mobileTheme.blue,
          color: "#06101f",
        }}
      >
        <Plus className="size-4" strokeWidth={1.8} />
      </button>
    </div>
  );
}

function Stat({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: number;
}) {
  return (
    <div
      className="rounded-lg border px-2 py-1.5"
      style={{
        backgroundColor: mobileTheme.bgElevated,
        borderColor: mobileTheme.borderSubtle,
      }}
    >
      <p
        className="font-mono text-[10px] font-extrabold leading-none tabular-nums"
        style={{ color: value > 0 ? color : mobileTheme.textFaint }}
      >
        {value}
      </p>
      <p
        className="mt-1 text-[5px] font-semibold"
        style={{ color: mobileTheme.textTertiary }}
      >
        {label}
      </p>
    </div>
  );
}

function SessionCard({
  onClick,
  selected,
  session,
}: {
  onClick: () => void;
  selected: boolean;
  session: Session;
}) {
  const working = session.section === "Working";

  return (
    <button
      type="button"
      onClick={onClick}
      className="mx-2 my-1 block min-h-11 w-[calc(100%-1rem)] rounded-lg border px-2 py-2 text-left outline-none transition-[background-color,border-color,scale] duration-150 active:scale-[0.96] focus-visible:ring-1"
      style={{
        backgroundColor: selected
          ? mobileTheme.bgElevatedHover
          : mobileTheme.bgElevated,
        borderColor: selected
          ? mobileTheme.blue
          : mobileTheme.borderSubtle,
      }}
    >
      <span className="flex items-center gap-1">
        <span className="relative flex size-1.5">
          {working ? (
            <span
              className="absolute inline-flex size-full animate-ping rounded-full opacity-35"
              style={{ backgroundColor: session.color }}
            />
          ) : null}
          <span
            className="relative size-1.5 rounded-full"
            style={{ backgroundColor: session.color }}
          />
        </span>
        <span
          className="text-[5px] font-semibold"
          style={{ color: session.color }}
        >
          {session.status}
        </span>
        <span
          className="ml-auto max-w-[44px] truncate font-mono text-[4.5px]"
          style={{ color: mobileTheme.textTertiary }}
        >
          {session.project}
        </span>
        <span
          className="font-mono text-[4.5px]"
          style={{ color: mobileTheme.textTertiary }}
        >
          #{session.id}
        </span>
      </span>
      <span className="mt-1 block truncate text-[7px] font-medium">
        {session.title}
      </span>
      <span
        className="mt-1 flex items-center gap-1 font-mono text-[4.5px]"
        style={{ color: mobileTheme.textTertiary }}
      >
        <GitBranch className="size-2" />
        <span className="min-w-0 flex-1 truncate">{session.branch}</span>
        <Terminal className="size-2.5" />
      </span>
    </button>
  );
}

function SecondaryScreen({ tab }: { tab: Exclude<Tab, "Kanban"> }) {
  const content = {
    Orchestrator: {
      eyebrow: "Main agent",
      title: "Coordinate the fleet",
      body: "Your orchestrator is live and ready to plan the next task.",
      action: "Open conversation",
    },
    PRs: {
      eyebrow: "Pull requests",
      title: "Two PRs need review",
      body: "CI and review state stay synced with every agent session.",
      action: "View pull requests",
    },
    Settings: {
      eyebrow: "Connection",
      title: "Desktop connected",
      body: "AO is paired over your local network at 192.168.88.3.",
      action: "Manage connection",
    },
  }[tab];

  return (
    <div className="flex h-full flex-col px-2.5 py-3">
      <div className="flex items-center justify-between">
        <h4 className="text-[13px] font-extrabold tracking-[-0.4px]">{tab}</h4>
        <span
          className="flex items-center gap-1 text-[5px] font-semibold"
          style={{ color: mobileTheme.textTertiary }}
        >
          <i
            className="size-1.5 rounded-full"
            style={{ backgroundColor: mobileTheme.green }}
          />
          live
        </span>
      </div>
      <div
        className="mt-7 rounded-xl border p-3"
        style={{
          backgroundColor: mobileTheme.bgElevated,
          borderColor: mobileTheme.borderSubtle,
        }}
      >
        <p
          className="font-mono text-[5px] uppercase tracking-[0.9px]"
          style={{ color: mobileTheme.blue }}
        >
          {content.eyebrow}
        </p>
        <p className="mt-2 text-[9px] font-bold">{content.title}</p>
        <p
          className="mt-2 text-pretty text-[6px] leading-[1.6]"
          style={{ color: mobileTheme.textSecondary }}
        >
          {content.body}
        </p>
        <button
          type="button"
          className="mt-4 min-h-8 w-full rounded-lg text-[6px] font-bold outline-none transition-transform duration-150 active:scale-[0.96] focus-visible:ring-2"
          style={{
            backgroundColor: mobileTheme.blue,
            color: "#06101f",
          }}
        >
          {content.action}
        </button>
      </div>
    </div>
  );
}

function BottomTabs({
  activeTab,
  onTabChange,
}: {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}) {
  return (
    <div
      className="grid h-11 shrink-0 grid-cols-4 border-t px-1 pb-1"
      style={{
        backgroundColor: mobileTheme.bgSurface,
        borderColor: mobileTheme.borderSubtle,
      }}
    >
      {tabs.map(({ icon: Icon, label }) => {
        const active = label === activeTab;
        return (
          <button
            key={label}
            type="button"
            onClick={() => onTabChange(label)}
            className="flex min-h-10 flex-col items-center justify-center gap-0.5 rounded-md outline-none transition-[color,scale] duration-150 active:scale-[0.96] focus-visible:ring-1"
            style={{
              color: active ? mobileTheme.blue : mobileTheme.textTertiary,
            }}
          >
            <Icon className="size-3" strokeWidth={1.8} />
            <span className="text-[4.5px] font-semibold">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
