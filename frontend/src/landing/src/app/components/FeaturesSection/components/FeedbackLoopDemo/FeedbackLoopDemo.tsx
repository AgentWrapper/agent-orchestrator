"use client";

import { domAnimation, LazyMotion, m } from "motion/react";
import { GeistMono } from "geist/font/mono";
import {
	ArrowUpDown,
	ArrowUpRight,
	Bell,
	Files,
	GitPullRequest,
	Maximize2,
	Minus,
	PanelRightClose,
	Plus,
	Trash2,
} from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { featurePreviewTokens } from "../FeaturePreviewShell";

/*
 * A miniature of the real AO session view: terminal pane + inspector rail.
 * Every surface here is the renderer's own, transcribed from
 *   frontend/src/renderer/components/CenterPane.tsx       (session topbar, agent tab)
 *   frontend/src/renderer/components/SessionInspector.tsx (tabs, sections, PR card, timeline)
 *   frontend/src/renderer/components/PRSummaryDisplay.tsx (PR meta + CI/Merge/Review parts)
 *   frontend/src/renderer/components/StatusPill.tsx       (timeline pills)
 * Copy comes from frontend/src/renderer/i18n/en.json, colors from
 * frontend/src/styles/tokens.css. Type is scaled ~0.82x so the whole session
 * view fits the preview card, the way the sibling feature demos do.
 */

/** Extra renderer tokens the shared preview set does not carry. */
const sessionPreviewTokens = {
	...featurePreviewTokens,
	"--preview-sidebar": "oklch(0.155 0.005 285.823)", // --sidebar
	"--preview-overlay": "oklch(0.28 0.008 285.885)", // --popover / bg-overlay
	"--preview-passive": "oklch(0.442 0.017 285.786)", // --chart-3 / text-passive
	"--preview-link": "oklch(0.92 0.004 286.32)", // --color-accent -> --primary
	"--preview-input": "oklch(1 0 0 / 4%)", // --color-bg-settings-input
	"--preview-input-border": "oklch(1 0 0 / 3%)", // --color-border-settings-input
	"--preview-interactive-active": "color-mix(in oklch, oklch(0.985 0 0) 7%, transparent)",
	// --color-bg-terminal is #101317e7 in the app, but it composites there over
	// the panel, not over a card on a lit page. Flattened so the pane reads as
	// the same near-black the app shows instead of picking up the card grey.
	"--preview-terminal": "#101317",
	"--preview-terminal-fg": "#d7d7d2", // --color-text-terminal
	"--preview-terminal-dim": "#7c7c7c", // --color-text-terminal-dim
} as CSSProperties;

/**
 * Rail width, shared by the inspector and by the topbar's action region so the
 * split reads as one hairline from the card's top edge to its bottom. 244px is
 * 297px at the 0.82x this preview runs at — inside the app's --size-inspector-min
 * (280px) floor, and wide enough that Kill + Orchestrator keep the app's padding.
 */
const RAIL_WIDTH = 244;

/** --color-status-* from tokens.css, plus the tones the PR parts map onto. */
const status = {
	working: "#60a5fa",
	needsYou: "#fb923c",
	ready: "#4ade80",
	idle: "oklch(0.705 0.015 286.067)",
	exited: "oklch(0.704 0.191 22.216)",
} as const;

type PartTone = "neutral" | "passive" | "success" | "warning" | "error";

/** PRSummaryDisplay's toneClass, resolved against the preview tokens. */
const partToneColor: Record<PartTone, string> = {
	neutral: "var(--preview-muted-foreground)",
	passive: "var(--preview-passive)",
	success: status.ready,
	warning: status.needsYou,
	error: status.exited,
};

type Pill = { label: string; tone: string; breathe: boolean };
type Part = { label: string; status: string; tone: PartTone; summary?: string; link?: string };

type Phase = {
	/** getAgentActivityView(): drives the agent tab's dot and the timeline pill. */
	activity: Pill;
	/** getSessionTimelinePillView(): the SCM pills beside it. */
	scm: Pill[];
	parts: Part[];
	diff: { files: number; additions: number; deletions: number };
	openedAgo: string;
};

const activityPills = {
	idle: { label: "Idle", tone: status.idle, breathe: false },
	working: { label: "Working", tone: status.working, breathe: true },
} as const;

const ciFailed: Pill = { label: "CI Failed", tone: status.exited, breathe: false };

const phases: Phase[] = [
	{
		// GitHub reported a failing check and an unresolved review; the agent is idle.
		activity: activityPills.idle,
		scm: [ciFailed],
		parts: [
			{ label: "CI", status: "Failing", tone: "error", link: "test / web" },
			{ label: "Merge", status: "Blocked", tone: "warning" },
			{ label: "Review", status: "Changes requested", tone: "warning", link: "prateek" },
		],
		diff: { files: 3, additions: 41, deletions: 12 },
		openedAgo: "18m ago",
	},
	{
		// AO routed the failure back into the session that owns the branch.
		activity: activityPills.working,
		scm: [ciFailed],
		parts: [
			{ label: "CI", status: "Failing", tone: "error", link: "test / web" },
			{ label: "Merge", status: "Blocked", tone: "warning" },
			{ label: "Review", status: "Changes requested", tone: "warning", link: "prateek" },
		],
		diff: { files: 3, additions: 41, deletions: 12 },
		openedAgo: "21m ago",
	},
	{
		// Fix pushed — GitHub is re-running the required checks.
		activity: activityPills.working,
		scm: [],
		parts: [
			{ label: "CI", status: "Pending", tone: "neutral" },
			{ label: "Merge", status: "Checking", tone: "passive" },
			{ label: "Review", status: "Changes requested", tone: "warning", link: "prateek" },
		],
		diff: { files: 4, additions: 47, deletions: 14 },
		openedAgo: "24m ago",
	},
	{
		activity: activityPills.idle,
		scm: [],
		parts: [
			{ label: "CI", status: "Passing", tone: "success" },
			{ label: "Merge", status: "Mergeable", tone: "success" },
			{ label: "Review", status: "Approved", tone: "success" },
		],
		diff: { files: 4, additions: 47, deletions: 14 },
		openedAgo: "26m ago",
	},
];

type LineTone = "fg" | "dim" | "error" | "success" | "working";

type Line = { id: string; phase: number; marker?: string; indent?: number; tone: LineTone; text: string; blank?: boolean };

/**
 * One accumulating transcript, the way a real pane behaves — the terminal keeps
 * its scrollback and tails the newest line, it does not swap screens between
 * states. Phase -1 is the scrollback this session had before CI spoke up.
 */
const transcriptLines: Omit<Line, "id">[] = [
	{ phase: -1, marker: "❯", tone: "fg", text: "Add GitHub OAuth callback handling." },
	{ phase: -1, blank: true, tone: "dim", text: "" },
	{ phase: -1, marker: "⏺", tone: "fg", text: "Search(pattern: \"oauth\", path: \"src\")" },
	{ phase: -1, marker: "⎿", tone: "dim", text: "Found 4 files" },
	{ phase: -1, marker: "⏺", tone: "fg", text: "Read(src/auth/session.ts)" },
	{ phase: -1, marker: "⎿", tone: "dim", text: "Read 54 lines" },
	{ phase: -1, marker: "⏺", tone: "fg", text: "Read(src/auth/index.ts)" },
	{ phase: -1, marker: "⎿", tone: "dim", text: "Read 88 lines" },
	{ phase: -1, marker: "⏺", tone: "fg", text: "Write(src/auth/callback.ts)" },
	{ phase: -1, marker: "⎿", tone: "dim", text: "Wrote 96 lines" },
	{ phase: -1, marker: "⏺", tone: "fg", text: "Write(src/auth/callback.test.ts)" },
	{ phase: -1, marker: "⎿", tone: "dim", text: "Wrote 61 lines" },
	{ phase: -1, marker: "⏺", tone: "fg", text: "Bash(npm test -- auth)" },
	{ phase: -1, marker: "⎿", tone: "success", text: "Tests  11 passed (11)" },
	{ phase: -1, marker: "⏺", tone: "fg", text: "Bash(git push origin feat/github-auth)" },
	{ phase: -1, marker: "⎿", tone: "dim", text: "4c1d0ab pushed to feat/github-auth" },
	{ phase: -1, marker: "⏺", tone: "fg", text: "Bash(gh pr create --fill)" },
	{ phase: -1, marker: "⎿", tone: "dim", text: ".../agent-orchestrator/pull/2481" },
	{ phase: -1, marker: "⏺", tone: "fg", text: "Opened PR #2481. Watching checks." },

	{ phase: 0, blank: true, tone: "dim", text: "" },
	{ phase: 0, marker: "·", tone: "working", text: "AO routed GitHub feedback here" },
	{ phase: 0, indent: 1, tone: "dim", text: 'PR #2481 · check "test / web" failed' },
	{ phase: 0, indent: 1, tone: "error", text: "FAIL  src/auth/callback.test.ts" },
	{ phase: 0, indent: 2, tone: "dim", text: "● rejects an expired state param" },
	{ phase: 0, indent: 3, tone: "dim", text: "expected 401, received 500" },

	{ phase: 1, blank: true, tone: "dim", text: "" },
	{ phase: 1, marker: "⏺", tone: "fg", text: "Read(src/auth/callback.ts)" },
	{ phase: 1, marker: "⎿", tone: "dim", text: "Read 143 lines" },
	{ phase: 1, marker: "⏺", tone: "fg", text: "The expiry check runs after the exchange." },
	{ phase: 1, marker: "⏺", tone: "fg", text: "Update(src/auth/callback.ts)" },
	{ phase: 1, marker: "⎿", tone: "dim", text: "Updated with 6 additions and 2 removals" },

	{ phase: 2, marker: "⏺", tone: "fg", text: "Bash(npm test -- auth/callback)" },
	{ phase: 2, marker: "⎿", tone: "success", text: "Tests  12 passed (12)" },
	{ phase: 2, marker: "⏺", tone: "fg", text: "Bash(git push origin feat/github-auth)" },
	{ phase: 2, marker: "⎿", tone: "dim", text: "91f8c2a pushed to feat/github-auth" },

	{ phase: 3, blank: true, tone: "dim", text: "" },
	{ phase: 3, marker: "·", tone: "working", text: "Checks re-ran on 91f8c2a" },
	{ phase: 3, indent: 1, tone: "success", text: "✓ test / web   ✓ typecheck   ✓ lint" },
	{ phase: 3, marker: "·", tone: "working", text: "PR #2481 is approved and mergeable" },
];

/** Stable per-line keys: the source array never reorders, so index-derived
 *  ids are stamped once here rather than recomputed at render. */
const transcript: Line[] = transcriptLines.map((line, index) => ({ ...line, id: `line-${index}` }));

const lineToneColor: Record<LineTone, string> = {
	fg: "var(--preview-terminal-fg)",
	dim: "var(--preview-terminal-dim)",
	error: status.exited,
	success: status.ready,
	working: status.working,
};

export function FeedbackLoopDemo() {
	const [active, setActive] = useState(0);

	useEffect(() => {
		const interval = window.setInterval(() => setActive((value) => (value + 1) % phases.length), 3400);
		return () => window.clearInterval(interval);
	}, []);

	const phase = phases[active] as Phase;

	// FeatureDemo lays this card out on a photo, and the grid lands it on a
	// fractional y, so the 1px 7%-white border falls across half a device pixel
	// and the photo bleeds through it as a green hairline. The tight dark ring
	// leading the shadow stack sits just outside the border box and gives that
	// edge something opaque to blend into.
	return (
		<div
			className="mx-auto w-full min-w-0 max-w-[620px] overflow-hidden rounded-xl border border-[var(--preview-border)] bg-[var(--preview-background)] font-sans text-[var(--preview-foreground)] antialiased shadow-[0_0_0_1px_rgba(0,0,0,0.55),0_28px_74px_-22px_rgba(0,0,0,0.86)]"
			style={sessionPreviewTokens}
		>
			<div className="flex h-[330px] min-w-0 flex-col sm:h-[408px]">
				<SessionTopbar phase={phase} />
				<div className="flex min-h-0 min-w-0 flex-1">
					<TerminalPane active={active} />
					{/* The rail's own edge is the split, so the topbar divider above it
					    and this hairline read as one unbroken rule. */}
					<Inspector phase={phase} />
				</div>
			</div>
		</div>
	);
}

/* ── Session topbar (CenterPane.tsx) ─────────────────────────────────────── */

function SessionTopbar({ phase }: { phase: Phase }) {
	// Flush to the card edge. The app insets this surface against the sidebar and
	// the native titlebar; there is no window chrome here to inset it from, so the
	// inset would only read as a stray gap.
	return (
		<div className="flex h-9 w-full shrink-0 items-stretch overflow-hidden border-b border-[var(--preview-border)] bg-[var(--preview-background)]">
			{/* Terminal region — exactly as wide as the pane below it, so the font
			    and fullscreen controls stop at the split instead of crossing it.
			    No vertical inset: the tab meets the card edge and the terminal. */}
			<div className="flex min-w-0 flex-1 items-stretch">
				<div className="flex min-w-0 flex-1 items-center">
					{/* The tab list takes the free space, so "new terminal" trails it. */}
					<div aria-label="Terminal tabs" className="flex min-w-0 flex-1 self-stretch items-center" role="tablist">
						{/* The permanent session tab — the only one branded by the harness. */}
						<span className="relative inline-flex min-w-0 shrink-0 self-stretch items-center gap-1.5 border-r border-[var(--preview-border)] bg-[var(--preview-overlay)] px-2.5 after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-[var(--preview-terminal)]">
							<img
								src="/app-icons/coverage-claude-code.svg"
								alt=""
								aria-hidden="true"
								className="size-[13px] shrink-0 object-contain"
								draggable={false}
							/>
							<span className="inline-flex items-center gap-1.5 text-[10.5px] font-medium leading-none text-[var(--preview-foreground)]">
								<span className="truncate">github-auth</span>
								<span
									className={`size-[5px] shrink-0 rounded-full ${phase.activity.breathe ? "animate-pulse" : ""}`}
									style={{ background: phase.activity.tone }}
								/>
							</span>
						</span>
					</div>
					<button
						type="button"
						aria-label="New terminal"
						className="grid size-[21px] shrink-0 place-items-center rounded-[5px] border border-[var(--preview-border)] text-[var(--preview-muted-foreground)]"
					>
						<Plus aria-hidden="true" className="size-3" />
					</button>
				</div>
				<div className="ml-1.5 mr-1.5 flex shrink-0 items-center gap-0.5 self-stretch border-l border-[var(--preview-border)] pl-1.5">
					<TerminalControl label="Decrease font size">
						<Minus aria-hidden="true" className="size-[11px]" />
					</TerminalControl>
					<span className="w-7 text-center font-mono text-[8px] tabular-nums text-[var(--preview-muted-foreground)]">
						12px
					</span>
					<TerminalControl label="Increase font size">
						<Plus aria-hidden="true" className="size-[11px]" />
					</TerminalControl>
					{/* h-4 in the app's 44px topbar — the same fraction of this 36px one. */}
					<span aria-hidden="true" className="mx-0.5 h-[13px] w-px bg-[var(--preview-border)]" />
					<TerminalControl label="Fullscreen">
						<Maximize2 aria-hidden="true" className="size-3" />
					</TerminalControl>
				</div>
			</div>
			{/* Session action region (ShellTopbar embedded). Pinned to the rail's
			    width so its left edge continues the split hairline below. */}
			<div
				className="hidden shrink-0 items-center justify-end gap-1 border-l border-[var(--preview-border)] px-1.5 sm:flex"
				style={{ width: RAIL_WIDTH }}
			>
				{/* Both actions carry TopbarButton's own metrics (h-control-lg, px-3.5,
				    gap-1.5, text-sm) at 0.82x, so the label sits centred in the box
				    instead of crowding its border. */}
				{/* The kill variant rests on a neutral border and only picks up
				    border-error/50 on hover. Nothing hovers in a still, so at this size
				    7% white read as a smudge around the red label — it takes the tone
				    partway to that hover border so the button reads as one object. */}
				<TopbarAction
					label="Kill session"
					className="border bg-transparent"
					style={{
						color: `color-mix(in srgb, ${status.exited} 80%, transparent)`,
						borderColor: `color-mix(in srgb, ${status.exited} 28%, transparent)`,
					}}
				>
					<Trash2 aria-hidden="true" className="size-[12px] shrink-0" />
					Kill
				</TopbarAction>
				<TopbarAction
					label="Open orchestrator"
					className="bg-[var(--preview-primary)] text-[var(--preview-primary-foreground)]"
				>
					<OrchestratorIcon />
					Orchestrator
				</TopbarAction>
				<button
					type="button"
					aria-label="Close inspector panel"
					title="Close inspector · ⌘⇧B"
					className="grid size-[22px] shrink-0 place-items-center rounded-[7px] text-[var(--preview-muted-foreground)]"
				>
					<PanelRightClose aria-hidden="true" className="size-[15px]" />
				</button>
				<span
					aria-label="Notifications"
					className="grid size-[22px] shrink-0 place-items-center rounded-[7px] text-[var(--preview-muted-foreground)]"
				>
					<Bell aria-hidden="true" className="size-[15px]" />
				</span>
			</div>
		</div>
	);
}

/** TopbarButton (TopbarButton.tsx) — the kill and primary variants share every
 *  metric, so the two actions differ only in fill. */
function TopbarAction({
	children,
	className,
	label,
	style,
}: {
	children: ReactNode;
	className: string;
	label: string;
	style?: CSSProperties;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			className={`inline-flex h-7 shrink-0 items-center justify-center gap-[5px] whitespace-nowrap rounded-[7px] px-[10px] text-[11px] font-semibold leading-none ${className}`}
			style={style}
		>
			{children}
		</button>
	);
}

function TerminalControl({ children, label }: { children: ReactNode; label: string }) {
	return (
		<button
			type="button"
			aria-label={label}
			className="grid size-5 shrink-0 place-items-center rounded-[5px] text-[var(--preview-muted-foreground)]"
		>
			{children}
		</button>
	);
}

/** OrchestratorIcon from frontend/src/renderer/components/icons.tsx. */
function OrchestratorIcon() {
	return (
		<svg
			className="size-3 shrink-0"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="4" r="2" />
			<circle cx="5" cy="20" r="2" />
			<circle cx="12" cy="20" r="2" />
			<circle cx="19" cy="20" r="2" />
			<path d="M12 6v12" />
			<path d="M5 11h14" />
			<path d="M5 11v7" />
			<path d="M19 11v7" />
		</svg>
	);
}

/* ── Terminal pane ───────────────────────────────────────────────────────── */

function TerminalPane({ active }: { active: number }) {
	const visible = transcript.filter((line) => line.phase <= active);
	const lastIndex = visible.length - 1;

	return (
		<main className="flex min-h-0 min-w-0 flex-1 flex-col justify-end overflow-hidden bg-[var(--preview-terminal)] px-3 py-2.5">
			<LazyMotion features={domAnimation}>
				<div className={`${GeistMono.className} text-[10px] leading-[1.35] text-[var(--preview-terminal-fg)]`}>
					{visible.map((line, index) => (
						<m.div
							key={line.id}
							initial={line.phase === active ? { opacity: 0 } : false}
							animate={{ opacity: 1 }}
							transition={{ duration: 0.18 }}
							className="flex min-w-0 items-start gap-1.5"
							style={{ color: lineToneColor[line.tone] }}
						>
							{line.blank ? (
								<span aria-hidden="true">&nbsp;</span>
							) : (
								<>
									<span className="w-[7px] shrink-0" style={{ marginLeft: (line.indent ?? 0) * 7 }}>
										{line.marker ?? ""}
									</span>
									<span className="min-w-0 whitespace-pre-wrap break-words">
										{line.text}
										{index === lastIndex && (active === 1 || active === 2) ? (
											<span className="ml-0.5 inline-block h-[9px] w-[5px] translate-y-[1px] animate-pulse bg-[var(--preview-terminal-fg)]" />
										) : null}
									</span>
								</>
							)}
						</m.div>
					))}
				</div>
			</LazyMotion>
		</main>
	);
}

/* ── Inspector rail (SessionInspector.tsx) ───────────────────────────────── */

function Inspector({ phase }: { phase: Phase }) {
	return (
		<aside
			aria-label="Session inspector"
			className="hidden shrink-0 flex-col overflow-hidden border-l border-[var(--preview-border)] sm:flex"
			style={{ width: RAIL_WIDTH }}
		>
			<div
				aria-label="Inspector views"
				className="flex h-[30px] shrink-0 items-center gap-1 border-b border-[var(--preview-border)] px-2.5"
				role="tablist"
			>
				{/* Under 350px the rail drops its tab labels and shows icons alone. */}
				<InspectorTab active label="Summary">
					<SummaryIcon />
				</InspectorTab>
				<InspectorTab label="Browser">
					<BrowserIcon />
				</InspectorTab>
				<InspectorTab label={`${phase.diff.files} Files`}>
					<Files aria-hidden="true" className="size-3" />
				</InspectorTab>
			</div>

			<div className="min-h-0 flex-1 overflow-hidden px-2 pb-3 pt-2">
				<Section title="Pull request">
					<PRSummaryCard phase={phase} />
				</Section>
				<Section title="Completion">
					<CompletionControls />
				</Section>
				<Section title="Activity">
					<ActivityTimeline phase={phase} />
				</Section>
			</div>
		</aside>
	);
}

function InspectorTab({ active = false, children, label }: { active?: boolean; children: ReactNode; label: string }) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			aria-label={label}
			title={label}
			className={`inline-flex size-6 shrink-0 items-center justify-center rounded-md ${
				active
					? "bg-[var(--preview-interactive-active)] text-[var(--preview-foreground)]"
					: "text-[var(--preview-passive)]"
			}`}
		>
			{children}
		</button>
	);
}

function Section({ children, title }: { children: ReactNode; title: string }) {
	// bg-settings-row is transparent in the dark theme; the box is padding alone.
	return (
		<section className="mb-1 last:mb-0">
			<div className="overflow-hidden rounded-[13px] px-3 py-2">
				<div className="mb-1.5 text-[8.5px] font-bold uppercase tracking-[0.06em] text-[var(--preview-muted-foreground)]">
					{title}
				</div>
				{children}
			</div>
		</section>
	);
}

/**
 * CompletionControls (SessionInspector.tsx): the merge policy every non-orchestrator
 * session carries. Off here, the way a session that is still working on its PR sits.
 */
function CompletionControls() {
	return (
		<div className="flex items-center justify-between gap-3 py-0.5">
			<span className="min-w-0 text-[10px] font-medium text-[var(--preview-foreground)]">Terminate on merge</span>
			<span
				aria-hidden="true"
				className="relative inline-flex h-[17px] w-[30px] shrink-0 items-center rounded-full border-[1.5px] border-transparent bg-[var(--preview-muted)]"
			>
				<span className="block h-[14px] w-[17px] rounded-full bg-[var(--preview-foreground)]" />
			</span>
		</div>
	);
}

function PRSummaryCard({ phase }: { phase: Phase }) {
	return (
		<div className="rounded-lg border border-[var(--preview-input-border)] bg-[var(--preview-input)] px-2 py-1.5">
			<div className="flex items-center gap-1.5">
				<GitPullRequest aria-hidden="true" className="size-3 shrink-0 text-[var(--preview-muted-foreground)]" />
				<span className="text-[10.5px] font-medium text-[var(--preview-foreground)]">PR #2481</span>
				{/* Badge + prStateTone.open. The app pairs a ring with a fill at 20px;
				    shrunk into this rail the two together made a saturated little
				    button that pulled rank on the PR number beside it. Fill alone,
				    lifted so it still separates from the card. */}
				<span
					className="inline-flex h-[16px] shrink-0 items-center rounded-full px-[6px] text-[8.5px] font-semibold leading-none tracking-[0.01em]"
					style={{
						color: status.ready,
						background: `color-mix(in srgb, ${status.ready} 18%, transparent)`,
					}}
				>
					open
				</span>
				<span className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-[9px] font-medium text-[var(--preview-link)]">
					Open
					<ArrowUpRight aria-hidden="true" className="size-2.5 shrink-0" strokeWidth={2} />
				</span>
			</div>
			<div className="mt-1 truncate text-[10px] font-medium leading-snug text-[var(--preview-foreground)]">
				Reject expired OAuth state
			</div>
			<div className="mt-1 min-w-0 font-mono text-[8.5px] leading-[1.4]">
				<div className="truncate text-[var(--preview-passive)]">feat/github-auth -&gt; main</div>
				<div className="flex min-w-0 flex-wrap items-center gap-x-1 text-[var(--preview-muted-foreground)]">
					<span className="inline-flex items-center gap-0.5" style={{ color: status.needsYou }}>
						<ArrowUpDown aria-hidden="true" className="h-2 w-2 shrink-0" strokeWidth={2.2} />
						{phase.diff.files} files
					</span>
					<span className="text-[var(--preview-passive)]">·</span>
					<span style={{ color: status.ready }}>+{phase.diff.additions}</span>
					<span className="text-[var(--preview-passive)]">·</span>
					<span style={{ color: status.exited }}>-{phase.diff.deletions}</span>
				</div>
			</div>
			<div className="mt-1.5 flex flex-col gap-0.5 font-mono text-[8.5px] leading-[1.4]">
				{phase.parts.map((part) => (
					<div key={part.label} className="flex min-w-0 flex-col">
						<div className="min-w-0 truncate">
							<span className="text-[var(--preview-passive)]">{part.label}</span>{" "}
							<span className="font-medium" style={{ color: partToneColor[part.tone] }}>
								{part.status}
							</span>
							{part.summary ? <span className="text-[var(--preview-passive)]"> · {part.summary}</span> : null}
						</div>
						{part.link ? (
							<span className="inline-flex min-w-0 max-w-full items-center gap-0.5 text-[var(--preview-link)]">
								<span className="truncate">{part.link}</span>
								<ArrowUpRight aria-hidden="true" className="size-2 shrink-0" strokeWidth={2} />
							</span>
						) : null}
					</div>
				))}
			</div>
		</div>
	);
}

/**
 * ActivityTimeline: the live reading sits on top, then history in reverse
 * chronological order, each event stamped with formatTimeCompact().
 */
function ActivityTimeline({ phase }: { phase: Phase }) {
	const events: { id: string; tone: "now" | "neutral"; node: ReactNode; ts: string | null }[] = [
		{
			id: "current",
			tone: "now",
			node: (
				<span className="inline-flex flex-wrap items-center gap-1">
					<StatusPill {...phase.activity} />
					{phase.scm.map((pill) => (
						<StatusPill key={pill.label} {...pill} />
					))}
				</span>
			),
			ts: null,
		},
		{
			id: "opened",
			tone: "neutral",
			node: (
				<span className="inline-flex min-w-0 items-center gap-0.5 text-[var(--preview-foreground)]">
					Opened&nbsp;<b className="font-semibold">PR #2481</b>
					<ArrowUpRight aria-hidden="true" className="size-2.5 shrink-0" strokeWidth={2} />
				</span>
			),
			ts: phase.openedAgo,
		},
	];

	return (
		<div className="relative pl-4">
			{events.map((event, index) => (
				<div key={event.id} className="relative pb-2.5 last:pb-0">
					{index < events.length - 1 ? (
						<span
							aria-hidden="true"
							className={`absolute -bottom-[7px] -left-[11px] w-px bg-[var(--preview-border)] ${
								event.tone === "now" ? "top-1/2" : "top-[8px]"
							}`}
						/>
					) : null}
					<div className="relative flex min-h-[8px] items-center">
						<span
							aria-hidden="true"
							className={`absolute -left-[14px] size-[7px] rounded-full ${
								event.tone === "now" ? "top-1/2 -translate-y-1/2" : "top-[4px]"
							}`}
							style={{
								background: event.tone === "now" ? status.working : "var(--preview-passive)",
								boxShadow:
									event.tone === "now"
										? `0 0 0 2.5px var(--preview-background), 0 0 6px ${status.working}`
										: "0 0 0 2.5px var(--preview-background)",
							}}
						/>
						<div className="min-w-0 text-[9.5px] leading-normal">{event.node}</div>
					</div>
					{event.ts ? (
						<div className="mt-0.5 font-mono text-[8px] text-[var(--preview-passive)]">{event.ts}</div>
					) : null}
				</div>
			))}
		</div>
	);
}

function StatusPill({ label, tone, breathe }: Pill) {
	return (
		<span
			className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[6px] px-1.5 py-[3px] text-[9px] font-semibold"
			style={{
				color: tone,
				background: `color-mix(in srgb, ${tone} 7%, transparent)`,
				boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tone} 25%, transparent)`,
			}}
		>
			<span className={`size-[5px] rounded-full ${breathe ? "animate-pulse" : ""}`} style={{ background: tone }} />
			{label}
		</span>
	);
}

/* Inspector tab icons — traced from VIEW_DEFS in SessionInspector.tsx. */

function SummaryIcon() {
	return (
		<svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
			<line x1="8" y1="7" x2="20" y2="7" />
			<line x1="8" y1="12" x2="20" y2="12" />
			<line x1="8" y1="17" x2="16" y2="17" />
			<circle cx="4" cy="7" r="1" />
			<circle cx="4" cy="12" r="1" />
			<circle cx="4" cy="17" r="1" />
		</svg>
	);
}

function BrowserIcon() {
	return (
		<svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
			<circle cx="12" cy="12" r="9" />
			<line x1="3" y1="12" x2="21" y2="12" />
			<path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18" />
		</svg>
	);
}
