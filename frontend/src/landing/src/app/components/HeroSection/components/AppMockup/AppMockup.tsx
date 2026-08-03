"use client";

import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export type { ActiveDemo } from "./types";

type BoardColumnId = "working" | "action" | "pending" | "merge";
type CardTone = "default" | "review" | "blocked" | "ready";
type ActivityState = "running" | "passed" | "failed" | "reviewing" | "waiting";
type TrackId = "landing" | "deploy" | "stars" | "icons" | "footer";
type ViewMode = "board" | "orchestrator";

interface PreviewCard {
	activity: string;
	activityState: ActivityState;
	agent: string;
	badge: string | null;
	branch: string;
	column: BoardColumnId;
	checks: string;
	files: string;
	id: string;
	icon: string;
	merging?: boolean;
	pr: string;
	time: string;
	title: string;
	tone: CardTone;
}

type StaticPreviewCard = Omit<PreviewCard, "column" | "id" | "merging">;

interface PreviewColumn {
	cards: StaticPreviewCard[];
	count: number;
	id: BoardColumnId;
	title: string;
}

interface TrackItem {
	id: TrackId;
	label: string;
	summary: string;
}

const repoName = "Untrivial-ai/agent-orchestrator";
const repoAvatar = "https://github.com/Untrivial-ai.png?size=64";

const previewTokenStyle = {
	"--preview-background": "#0a0b0d",
	"--preview-foreground": "#f4f5f7",
	"--preview-card": "#15171b",
	"--preview-card-foreground": "#f4f5f7",
	"--preview-primary": "#2e63b8",
	"--preview-primary-foreground": "#ffffff",
	"--preview-muted": "#1b1d22",
	"--preview-muted-foreground": "#9ba1aa",
	"--preview-accent": "#4d8dff",
	"--preview-border": "rgb(255 255 255 / 0.06)",
	"--preview-border-strong": "rgb(255 255 255 / 0.1)",
	"--preview-divider": "rgb(255 255 255 / 0.15)",
	"--preview-input": "rgb(255 255 255 / 0.15)",
	"--preview-ring": "#4d8dff",
	"--preview-sidebar": "#17181c",
	"--preview-sidebar-foreground": "#f4f5f7",
	"--preview-sidebar-accent": "rgb(255 255 255 / 0.07)",
	"--preview-sidebar-hover": "rgb(255 255 255 / 0.04)",
	"--preview-sidebar-border": "rgb(255 255 255 / 0.06)",
	"--preview-passive": "#646a73",
	"--preview-raised": "#212329",
} as CSSProperties;

const STATUS_COLORS = {
	idle: "#8e96a3",
	working: "#36c2b4",
	needsYou: "#f2b84b",
	inReview: "#5b8def",
	ready: "#9ad97a",
	merged: "#3e9b62",
	unknown: "#a78bfa",
} as const;

/** Initial sidebar width for the landing mockup (also seeds resize clamping). */
const SIDEBAR_DEFAULT_WIDTH = 218;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 320;

const previewAgents = {
	claude: { agent: "Claude", icon: "/app-icons/agents/claude-code.svg" },
	codex: { agent: "Codex", icon: "/app-icons/agents/codex.svg" },
	cursor: { agent: "Cursor", icon: "/app-icons/agents/cursor.svg" },
	opencode: { agent: "OpenCode", icon: "/app-icons/agents/opencode.svg" },
	copilot: { agent: "Copilot", icon: "/app-icons/agents/copilot.png" },
	gemini: { agent: "Gemini", icon: "/app-icons/gemini.svg" },
	aider: { agent: "Aider", icon: "/app-icons/agents/aider.png" },
	grok: { agent: "Grok", icon: "/app-icons/agents/grok.png" },
	devin: { agent: "Devin", icon: "/app-icons/agents/devin.png" },
	kimi: { agent: "Kimi", icon: "/app-icons/agents/kimi.png" },
	amp: { agent: "Amp", icon: "/app-icons/agents/amp.svg" },
	cline: { agent: "Cline", icon: "/app-icons/agents/cline.svg" },
	goose: { agent: "Goose", icon: "/app-icons/agents/goose.svg" },
	continue: { agent: "Continue", icon: "/app-icons/agents/continue.png" },
	pi: { agent: "Pi", icon: "/app-icons/agents/pi.png" },
	kilocode: { agent: "Kilo Code", icon: "/app-icons/agents/kilocode.svg" },
} as const;

type PreviewAgentKey = keyof typeof previewAgents;

const columns = [
	{
		id: "working",
		title: "Working",
		count: 9,
		cards: [
			{
				title: "Port Figma board mock into the hero preview",
				branch: "ao/dev/agent-orchestrator-12/root",
				agent: previewAgents.gemini.agent,
				icon: previewAgents.gemini.icon,
				activity: "Working",
				activityState: "running",
				pr: "PR #318",
				checks: "checks running",
				files: "7 files",
				time: "12m ago",
				badge: null,
				tone: "default",
			},
			{
				title: "Polish the landing preview app chrome",
				branch: "landing/preview-chrome",
				agent: previewAgents.codex.agent,
				icon: previewAgents.codex.icon,
				activity: "Running tests",
				activityState: "running",
				pr: "PR #319",
				checks: "unit tests queued",
				files: "5 files",
				time: "18m ago",
				badge: null,
				tone: "default",
			},
		],
	},
	{
		id: "action",
		title: "Needs you",
		count: 4,
		cards: [
			{
				title: "Pick final titlebar metrics for the preview",
				branch: "ao/dev/agent-orchestrator-18/root",
				agent: previewAgents.copilot.agent,
				icon: previewAgents.copilot.icon,
				activity: "Input needed",
				activityState: "waiting",
				pr: "PR #322",
				checks: "review comments 4",
				files: "1 file",
				time: "46m ago",
				badge: "Changes requested",
				tone: "blocked",
			},
			{
				title: "Confirm whether download labels stay platform-aware",
				branch: "ao/dev/solkit-ui-6/root",
				agent: previewAgents.cursor.agent,
				icon: previewAgents.cursor.icon,
				activity: "Input needed",
				activityState: "waiting",
				pr: "PR #323",
				checks: "needs product call",
				files: "3 files",
				time: "1h ago",
				badge: "Needs input",
				tone: "blocked",
			},
		],
	},
	{
		id: "pending",
		title: "In review",
		count: 5,
		cards: [
			{
				title: "Preload GitHub stars before hydration",
				branch: "ao/dev/agent-orchestrator-21/root",
				agent: previewAgents.aider.agent,
				icon: previewAgents.aider.icon,
				activity: "Review pending",
				activityState: "passed",
				pr: "PR #324",
				checks: "checks passed",
				files: "2 files",
				time: "1h ago",
				badge: "Changes requested",
				tone: "review",
			},
			{
				title: "Ignore local reference snapshots in deploy payloads",
				branch: "ao/dev/agent-orchestrator-22/root",
				agent: previewAgents.opencode.agent,
				icon: previewAgents.opencode.icon,
				activity: "Review pending",
				activityState: "reviewing",
				pr: "PR #325",
				checks: "review pending",
				files: "2 files",
				time: "2h ago",
				badge: "Awaiting review",
				tone: "review",
			},
		],
	},
	{
		id: "merge",
		title: "Mergeable",
		count: 3,
		cards: [
			{
				title: "Ship AO logo in top navigation",
				branch: "ao/dev/agent-orchestrator-8/root",
				agent: previewAgents.devin.agent,
				icon: previewAgents.devin.icon,
				activity: "Ready",
				activityState: "passed",
				pr: "PR #326",
				checks: "approved",
				files: "2 files",
				time: "3h ago",
				badge: "Ready",
				tone: "ready",
			},
			{
				title: "Stabilize Vercel framework detection",
				branch: "ao/dev/agent-orchestrator-9/root",
				agent: previewAgents.kimi.agent,
				icon: previewAgents.kimi.icon,
				activity: "Ready",
				activityState: "passed",
				pr: "PR #327",
				checks: "merge queue",
				files: "3 files",
				time: "4h ago",
				badge: "Ready",
				tone: "ready",
			},
		],
	},
] satisfies PreviewColumn[];

const COLUMN_COLORS: Record<BoardColumnId, string> = {
	working: STATUS_COLORS.working,
	action: STATUS_COLORS.needsYou,
	pending: STATUS_COLORS.inReview,
	merge: STATUS_COLORS.ready,
};

const projectItems: TrackItem[] = [
	{
		id: "landing",
		label: "smooth card",
		summary: "Refresh the hero board, topbar, and landing sections without losing the AO product language.",
	},
	{
		id: "deploy",
		label: "vercel",
		summary: "Keep framework detection and deploy payloads boring so every preview goes live cleanly.",
	},
	{
		id: "stars",
		label: "preload",
		summary: "Move remote counts into server-rendered data so hydration does not shift the hero controls.",
	},
	{
		id: "icons",
		label: "harness",
		summary: "Replace placeholder logos with real harness marks and keep the compatibility showcase readable.",
	},
	{
		id: "footer",
		label: "footer",
		summary: "Verify footer grids, demo video placement, and section order across the landing page.",
	},
];

function previewCard(
	card: Pick<
		StaticPreviewCard,
		"title" | "branch" | "activity" | "activityState" | "pr"
	> &
		Partial<StaticPreviewCard> & { agentKey?: PreviewAgentKey },
): StaticPreviewCard {
	const { agentKey = "codex", ...rest } = card;
	const defaults = previewAgents[agentKey];
	return {
		agent: defaults.agent,
		icon: defaults.icon,
		badge: null,
		checks: "checks running",
		files: "2 files",
		time: "18m ago",
		tone: "default",
		...rest,
	};
}

const trackCardTemplates: Record<TrackId, StaticPreviewCard[]> = {
	landing: columns.flatMap((column) =>
		column.cards.slice(0, 1).map((card) => ({ ...card }) as StaticPreviewCard),
	),
	deploy: [
		previewCard({
			title: "Pin the Vercel monorepo root",
			branch: "deploy/vercel-root",
			activity: "Updating project config",
			activityState: "running",
			pr: "PR #411",
			agentKey: "codex",
		}),
		previewCard({
			title: "Choose production region failover",
			branch: "deploy/region-failover",
			activity: "Waiting for infra decision",
			activityState: "waiting",
			pr: "PR #414",
			agentKey: "grok",
			badge: "Needs input",
			tone: "blocked",
		}),
		previewCard({
			title: "Verify preview environment variables",
			branch: "deploy/preview-env",
			activity: "Deployment checks running",
			activityState: "reviewing",
			pr: "PR #415",
			agentKey: "opencode",
			badge: "Awaiting review",
			tone: "review",
		}),
		previewCard({
			title: "Cache workspace dependencies in builds",
			branch: "deploy/workspace-cache",
			activity: "Production deploy green",
			activityState: "passed",
			pr: "PR #409",
			agentKey: "gemini",
			badge: "Ready",
			tone: "ready",
		}),
	],
	stars: [
		previewCard({
			title: "Fetch GitHub stars during revalidation",
			branch: "metrics/server-stars",
			activity: "Adding cached fetch",
			activityState: "running",
			pr: "PR #428",
			agentKey: "amp",
		}),
		previewCard({
			title: "Set the stale count fallback",
			branch: "metrics/star-fallback",
			activity: "Waiting on product copy",
			activityState: "waiting",
			pr: "PR #430",
			agentKey: "cursor",
			badge: "Needs input",
			tone: "blocked",
		}),
		previewCard({
			title: "Prevent hero metrics hydration shift",
			branch: "metrics/hydration-layout",
			activity: "Visual regression review",
			activityState: "reviewing",
			pr: "PR #432",
			agentKey: "continue",
			badge: "Awaiting review",
			tone: "review",
		}),
		previewCard({
			title: "Preload the repository avatar",
			branch: "metrics/avatar-preload",
			activity: "Performance checks passed",
			activityState: "passed",
			pr: "PR #426",
			agentKey: "kimi",
			badge: "Ready",
			tone: "ready",
		}),
	],
	icons: [
		previewCard({
			title: "Replace placeholder harness marks",
			branch: "icons/harness-marks",
			activity: "Updating icon assets",
			activityState: "running",
			pr: "PR #447",
			agentKey: "opencode",
		}),
		previewCard({
			title: "Pick a fallback for unknown agents",
			branch: "icons/agent-fallback",
			activity: "Waiting for design input",
			activityState: "waiting",
			pr: "PR #450",
			agentKey: "cline",
			badge: "Needs input",
			tone: "blocked",
		}),
		previewCard({
			title: "Audit dark-mode logo contrast",
			branch: "icons/dark-contrast",
			activity: "Design review in progress",
			activityState: "reviewing",
			pr: "PR #452",
			agentKey: "cursor",
			badge: "Awaiting review",
			tone: "review",
		}),
		previewCard({
			title: "Remove stale generated icon imports",
			branch: "icons/remove-stale-imports",
			activity: "Asset checks passed",
			activityState: "passed",
			pr: "PR #444",
			agentKey: "kilocode",
			badge: "Ready",
			tone: "ready",
		}),
	],
	footer: [
		previewCard({
			title: "Test footer columns at mobile widths",
			branch: "qa/footer-mobile",
			activity: "Running viewport checks",
			activityState: "running",
			pr: "PR #468",
			agentKey: "codex",
		}),
		previewCard({
			title: "Confirm final demo video caption",
			branch: "qa/video-caption",
			activity: "Waiting for copy approval",
			activityState: "waiting",
			pr: "PR #471",
			agentKey: "pi",
			badge: "Needs input",
			tone: "blocked",
		}),
		previewCard({
			title: "Check section order across routes",
			branch: "qa/section-order",
			activity: "Cross-browser review",
			activityState: "reviewing",
			pr: "PR #473",
			agentKey: "goose",
			badge: "Awaiting review",
			tone: "review",
		}),
		previewCard({
			title: "Fix footer placeholder row spacing",
			branch: "qa/footer-spacing",
			activity: "Responsive checks passed",
			activityState: "passed",
			pr: "PR #465",
			agentKey: "copilot",
			badge: "Ready",
			tone: "ready",
		}),
	],
};

const landingIncomingCards: StaticPreviewCard[] = [
	{
		title: "Tighten hero window border alignment",
		branch: "landing/window-border-pass",
		...previewAgents.gemini,
		activity: "Editing file",
		activityState: "running",
		pr: "draft",
		checks: "editing",
		files: "1 file",
		time: "now",
		badge: null,
		tone: "default",
	},
	{
		title: "Repair mobile overflow on landing preview",
		branch: "landing/mobile-preview-overflow",
		...previewAgents.codex,
		activity: "Debugging issue",
		activityState: "running",
		pr: "draft",
		checks: "debugging",
		files: "4 files",
		time: "now",
		badge: null,
		tone: "default",
	},
	{
		title: "Remove stale generated icon imports",
		branch: "cleanup/stale-icon-imports",
		...previewAgents.opencode,
		activity: "Deleting file",
		activityState: "running",
		pr: "draft",
		checks: "cleanup",
		files: "2 files",
		time: "now",
		badge: null,
		tone: "default",
	},
	{
		title: "Make the kanban loop feel less mechanical",
		branch: "landing/random-kanban-loop",
		...previewAgents.devin,
		activity: "Tuning animation",
		activityState: "running",
		pr: "draft",
		checks: "animation pass",
		files: "1 file",
		time: "now",
		badge: null,
		tone: "default",
	},
	{
		title: "Shrink card metadata copy for preview scale",
		branch: "landing/card-density",
		...previewAgents.cursor,
		activity: "Editing file",
		activityState: "running",
		pr: "draft",
		checks: "editing",
		files: "1 file",
		time: "now",
		badge: null,
		tone: "default",
	},
	{
		title: "Verify GitHub avatar fallback in project list",
		branch: "landing/repo-avatar",
		...previewAgents.aider,
		activity: "Running tests",
		activityState: "running",
		pr: "draft",
		checks: "tests",
		files: "2 files",
		time: "now",
		badge: null,
		tone: "default",
	},
	{
		title: "Tune titlebar action spacing against Figma",
		branch: "landing/titlebar-actions",
		...previewAgents.copilot,
		activity: "Measuring layout",
		activityState: "running",
		pr: "draft",
		checks: "layout pass",
		files: "1 file",
		time: "now",
		badge: null,
		tone: "default",
	},
	{
		title: "Replace placeholder project copy with repo-specific tasks",
		branch: "landing/organic-dummy-data",
		...previewAgents.goose,
		activity: "Writing copy",
		activityState: "running",
		pr: "draft",
		checks: "copy pass",
		files: "1 file",
		time: "now",
		badge: null,
		tone: "default",
	},
	{
		title: "Smooth card collapse when PRs merge out",
		branch: "landing/merge-collapse-motion",
		...previewAgents.cline,
		activity: "Debugging issue",
		activityState: "running",
		pr: "draft",
		checks: "motion debug",
		files: "1 file",
		time: "now",
		badge: null,
		tone: "default",
	},
];

const incomingCardsByTrack: Record<TrackId, StaticPreviewCard[]> = {
	landing: landingIncomingCards,
	deploy: [
		previewCard({
			title: "Add deploy health-check retries",
			branch: "deploy/health-retries",
			activity: "Editing deployment workflow",
			activityState: "running",
			pr: "draft",
			agentKey: "amp",
		}),
		previewCard({
			title: "Document preview alias ownership",
			branch: "deploy/alias-ownership",
			activity: "Writing deployment notes",
			activityState: "running",
			pr: "draft",
			agentKey: "gemini",
		}),
	],
	stars: [
		previewCard({
			title: "Add rate-limit telemetry for star fetches",
			branch: "metrics/star-rate-limit",
			activity: "Instrumenting cache requests",
			activityState: "running",
			pr: "draft",
			agentKey: "kimi",
		}),
		previewCard({
			title: "Test zero-star fallback rendering",
			branch: "metrics/zero-state",
			activity: "Writing component tests",
			activityState: "running",
			pr: "draft",
			agentKey: "continue",
		}),
	],
	icons: [
		previewCard({
			title: "Normalize harness icon viewboxes",
			branch: "icons/viewbox-normalization",
			activity: "Editing SVG assets",
			activityState: "running",
			pr: "draft",
			agentKey: "kilocode",
		}),
		previewCard({
			title: "Add Gemini CLI authorized state",
			branch: "icons/gemini-state",
			activity: "Updating harness preview",
			activityState: "running",
			pr: "draft",
			agentKey: "gemini",
		}),
	],
	footer: [
		previewCard({
			title: "Verify video controls on iOS",
			branch: "qa/video-ios",
			activity: "Running device checks",
			activityState: "running",
			pr: "draft",
			agentKey: "devin",
		}),
		previewCard({
			title: "Audit footer links and focus order",
			branch: "qa/footer-focus",
			activity: "Testing keyboard navigation",
			activityState: "running",
			pr: "draft",
			agentKey: "pi",
		}),
	],
};

const BASE_WIDTH = 1140;
const BASE_HEIGHT = 615;
const WINDOW_ASPECT = BASE_WIDTH / BASE_HEIGHT;
const WINDOW_MARGIN = 4;
// Shell can shrink with the hero frame; inner board stays at BASE_* and CSS-scales.
// Keep the shell aspect-locked so the scaled board fills both axes (no letterbox gaps).
const MIN_WINDOW_WIDTH = 280;

interface WindowState {
	x: number;
	y: number;
	width: number;
	height: number;
}

function sizeFromWidth(width: number): Pick<WindowState, "width" | "height"> {
	return { width, height: width / WINDOW_ASPECT };
}

function sizeFromHeight(height: number): Pick<WindowState, "width" | "height"> {
	return { width: height * WINDOW_ASPECT, height };
}

/** Fit a width into max bounds while preserving the design aspect ratio. */
function fitAspectWidth(
	desiredWidth: number,
	maxWidth: number,
	maxHeight: number,
): Pick<WindowState, "width" | "height"> {
	let { width, height } = sizeFromWidth(desiredWidth);
	if (width > maxWidth) ({ width, height } = sizeFromWidth(maxWidth));
	if (height > maxHeight) ({ width, height } = sizeFromHeight(maxHeight));
	if (width > maxWidth) ({ width, height } = sizeFromWidth(maxWidth));

	const minWidth = Math.min(MIN_WINDOW_WIDTH, maxWidth);
	const minSized = sizeFromWidth(minWidth);
	if (width < minSized.width && minSized.height <= maxHeight) {
		({ width, height } = minSized);
	}
	return { width, height };
}

function clampWindowState(
	state: WindowState,
	containerWidth: number,
	containerHeight: number,
): WindowState {
	const maxWidth = Math.max(1, containerWidth - WINDOW_MARGIN * 2);
	const maxHeight = Math.max(1, containerHeight - WINDOW_MARGIN * 2);
	const { width, height } = fitAspectWidth(state.width, maxWidth, maxHeight);
	const x = Math.max(WINDOW_MARGIN, Math.min(state.x, containerWidth - width - WINDOW_MARGIN));
	const y = Math.max(WINDOW_MARGIN, Math.min(state.y, containerHeight - height - WINDOW_MARGIN));
	return { x, y, width, height };
}

function createInitialWindowState(
	containerWidth: number,
	containerHeight: number,
): WindowState {
	const availableWidth = containerWidth - WINDOW_MARGIN * 2;
	const availableHeight = containerHeight - WINDOW_MARGIN * 2;
	const scale = Math.min(
		1,
		availableWidth / BASE_WIDTH,
		availableHeight / BASE_HEIGHT,
	);
	const { width, height } = sizeFromWidth(BASE_WIDTH * scale);
	return {
		x: (containerWidth - width) / 2,
		y: (containerHeight - height) / 2,
		width,
		height,
	};
}

const mockupShellStyle = {
	...previewTokenStyle,
	"--mockup-design-w": `${BASE_WIDTH}px`,
	"--mockup-design-h": `${BASE_HEIGHT}px`,
} as CSSProperties;

function useFloatingWindow(
	outerRef: React.RefObject<HTMLElement | null>,
) {
	const stateRef = useRef<WindowState | null>(null);
	// The geometry the user asked for, kept unclamped by container size. Narrow
	// containers squash the rendered state into the corner; replaying from this
	// instead lets a return to a wide viewport restore the original placement.
	const desiredStateRef = useRef<WindowState | null>(null);
	const containerSizeRef = useRef({ width: 0, height: 0 });
	const interactionRef = useRef<{
		type: "drag" | "resize";
		direction?: string;
		startX: number;
		startY: number;
		initial: WindowState;
	} | null>(null);

	const applyState = useCallback(() => {
		const outer = outerRef.current;
		const state = stateRef.current;
		if (!outer || !state) return;
		outer.style.left = `${state.x}px`;
		outer.style.top = `${state.y}px`;
		outer.style.width = `${state.width}px`;
		outer.style.height = `${state.height}px`;
		outer.style.transform = "none";
	}, [outerRef]);

	const updateContainer = useCallback(() => {
		const outer = outerRef.current;
		const parent = outer?.offsetParent as HTMLElement | null;
		if (!parent) return;
		const rect = parent.getBoundingClientRect();
		containerSizeRef.current = { width: rect.width, height: rect.height };
		const maxWidth = Math.max(1, rect.width - WINDOW_MARGIN * 2);
		const maxHeight = Math.max(1, rect.height - WINDOW_MARGIN * 2);
		const desired = desiredStateRef.current;
		const fitted = createInitialWindowState(rect.width, rect.height);
		// Until the user drags/resizes, always re-fit to the container. If a prior
		// desired size no longer fits (viewport shrunk), drop it and re-center.
		const desiredFits =
			desired != null &&
			desired.width <= maxWidth + 0.5 &&
			desired.height <= maxHeight + 0.5;
		stateRef.current = clampWindowState(
			desiredFits && desired ? desired : fitted,
			rect.width,
			rect.height,
		);
		if (desired && !desiredFits) {
			desiredStateRef.current = null;
		}
		applyState();
	}, [applyState, outerRef]);

	useLayoutEffect(() => {
		updateContainer();
		const outer = outerRef.current;
		const parent = outer?.offsetParent as HTMLElement | null;
		if (!parent) return;
		const observer = new ResizeObserver(updateContainer);
		observer.observe(parent);
		window.addEventListener("resize", updateContainer);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", updateContainer);
		};
	}, [updateContainer, outerRef]);

	const startDrag = useCallback((clientX: number, clientY: number) => {
		if (!stateRef.current) return;
		interactionRef.current = {
			type: "drag",
			startX: clientX,
			startY: clientY,
			initial: { ...stateRef.current },
		};
	}, []);

	const startResize = useCallback(
		(direction: string, clientX: number, clientY: number) => {
			if (!stateRef.current) return;
			interactionRef.current = {
				type: "resize",
				direction,
				startX: clientX,
				startY: clientY,
				initial: { ...stateRef.current },
			};
		},
		[],
	);

	useEffect(() => {
		const handleMove = (event: PointerEvent) => {
			const interaction = interactionRef.current;
			if (!interaction || !stateRef.current) return;
			const { width: containerWidth, height: containerHeight } =
				containerSizeRef.current;
			const dx = event.clientX - interaction.startX;
			const dy = event.clientY - interaction.startY;
			let next: WindowState = { ...interaction.initial };

			if (interaction.type === "drag") {
				next.x = interaction.initial.x + dx;
				next.y = interaction.initial.y + dy;
			} else if (interaction.type === "resize" && interaction.direction) {
				const dir = interaction.direction;
				const initial = interaction.initial;
				const widthDelta = dir.includes("e") ? dx : dir.includes("w") ? -dx : 0;
				const heightDelta = dir.includes("s") ? dy : dir.includes("n") ? -dy : 0;

				// Aspect-lock: edge drags follow that axis; corners follow the dominant delta.
				let sized: Pick<WindowState, "width" | "height">;
				if (dir === "e" || dir === "w") {
					sized = sizeFromWidth(initial.width + widthDelta);
				} else if (dir === "n" || dir === "s") {
					sized = sizeFromHeight(initial.height + heightDelta);
				} else if (Math.abs(widthDelta) >= Math.abs(heightDelta)) {
					sized = sizeFromWidth(initial.width + widthDelta);
				} else {
					sized = sizeFromHeight(initial.height + heightDelta);
				}

				next.width = sized.width;
				next.height = sized.height;
				if (dir.includes("w")) {
					next.x = initial.x + initial.width - next.width;
				}
				if (dir.includes("n")) {
					next.y = initial.y + initial.height - next.height;
				}
			}

			next = clampWindowState(next, containerWidth, containerHeight);
			desiredStateRef.current = next;
			stateRef.current = next;
			applyState();
		};

		const handleUp = () => {
			interactionRef.current = null;
		};

		window.addEventListener("pointermove", handleMove);
		window.addEventListener("pointerup", handleUp);
		return () => {
			window.removeEventListener("pointermove", handleMove);
			window.removeEventListener("pointerup", handleUp);
		};
	}, [applyState]);

	return { startDrag, startResize };
}

function ResizeHandle({
	className,
	cursor,
	direction,
	onResizeStart,
}: {
	className: string;
	cursor: string;
	direction: string;
	onResizeStart: (direction: string, clientX: number, clientY: number) => void;
}) {
	return (
		<div
			className={`absolute z-20 ${cursor} ${className}`}
			onPointerDown={(event) => {
				event.preventDefault();
				event.stopPropagation();
				onResizeStart(direction, event.clientX, event.clientY);
			}}
		/>
	);
}

function ResizeHandles({
	onResizeStart,
}: {
	onResizeStart: (direction: string, clientX: number, clientY: number) => void;
}) {
	return (
		<>
			<ResizeHandle
				className="-left-1 -top-1 h-3 w-3"
				cursor="cursor-nwse-resize"
				direction="nw"
				onResizeStart={onResizeStart}
			/>
			<ResizeHandle
				className="-right-1 -top-1 h-3 w-3"
				cursor="cursor-nesw-resize"
				direction="ne"
				onResizeStart={onResizeStart}
			/>
			<ResizeHandle
				className="-left-1 -bottom-1 h-3 w-3"
				cursor="cursor-nesw-resize"
				direction="sw"
				onResizeStart={onResizeStart}
			/>
			<ResizeHandle
				className="-right-1 -bottom-1 h-3 w-3"
				cursor="cursor-nwse-resize"
				direction="se"
				onResizeStart={onResizeStart}
			/>
			<ResizeHandle
				className="left-2 right-2 -top-1 h-2"
				cursor="cursor-ns-resize"
				direction="n"
				onResizeStart={onResizeStart}
			/>
			<ResizeHandle
				className="left-2 right-2 -bottom-1 h-2"
				cursor="cursor-ns-resize"
				direction="s"
				onResizeStart={onResizeStart}
			/>
			<ResizeHandle
				className="-left-1 top-2 bottom-2 w-2"
				cursor="cursor-ew-resize"
				direction="w"
				onResizeStart={onResizeStart}
			/>
			<ResizeHandle
				className="-right-1 top-2 bottom-2 w-2"
				cursor="cursor-ew-resize"
				direction="e"
				onResizeStart={onResizeStart}
			/>
		</>
	);
}

function createInitialCards(trackId: TrackId): PreviewCard[] {
	return columns.flatMap((column, index) => {
		const card = trackCardTemplates[trackId][index];
		return card
			? [{
					...card,
					column: column.id,
					id: `${trackId}-${column.id}`,
				}]
			: [];
	});
}

function createInitialCardsByTrack(): Record<TrackId, PreviewCard[]> {
	return Object.fromEntries(
		projectItems.map(({ id }) => [id, createInitialCards(id)]),
	) as Record<TrackId, PreviewCard[]>;
}

function advanceCard(card: PreviewCard): PreviewCard {
	if (card.column === "working") {
		return {
			...card,
			column: "action",
			activity: "Input needed",
			activityState: "waiting",
			badge: "Needs input",
			tone: "blocked",
			time: "just now",
		};
	}

	if (card.column === "action") {
		return {
			...card,
			column: "pending",
			activity: "Review pending",
			activityState: "reviewing",
			badge: "Awaiting review",
			tone: "review",
			time: "just now",
		};
	}

	return {
		...card,
		column: "merge",
		activity: "Ready",
		activityState: "passed",
		badge: "Ready",
		tone: "ready",
		time: "just now",
	};
}

function cardStatusColor(card: PreviewCard): string {
	if (card.column === "action" || card.tone === "blocked") return STATUS_COLORS.needsYou;
	if (card.column === "pending" || card.tone === "review") return STATUS_COLORS.inReview;
	if (card.column === "merge" || card.tone === "ready") return STATUS_COLORS.ready;
	if (card.activityState === "running") return STATUS_COLORS.working;
	return STATUS_COLORS.idle;
}

/** Most-urgent board status for a track — same palette as kanban card dots. */
function trackDotColor(cards: PreviewCard[]): string {
	if (cards.length === 0) return STATUS_COLORS.idle;
	let best = cards[0]!;
	let bestRank = cardAttentionRank(best);
	for (const card of cards) {
		const rank = cardAttentionRank(card);
		if (rank < bestRank) {
			best = card;
			bestRank = rank;
		}
	}
	return cardStatusColor(best);
}

function cardAttentionRank(card: PreviewCard): number {
	if (card.column === "action" || card.tone === "blocked") return 0;
	if (card.activityState === "running") return 1;
	if (card.column === "pending" || card.tone === "review") return 2;
	if (card.column === "merge" || card.tone === "ready") return 3;
	return 4;
}

function isIdleCard(card: PreviewCard): boolean {
	return card.column === "working" && card.activityState !== "running";
}

function randomDelay() {
	return 1000 + Math.random() * 2000;
}

function randomItem<T>(items: T[]): T | null {
	if (items.length === 0) return null;
	return items[Math.floor(Math.random() * items.length)] ?? null;
}

// The preview is a prop, not a real app. It exposes ~13 fake controls, so pull the
// whole subtree out of the tab order and let the root stand in for it as a single
// image node. Runs after every render because cards mount and unmount constantly.
function useDecorativeSubtree(rootRef: React.RefObject<HTMLElement | null>) {
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;

		const focusable = root.querySelectorAll<HTMLElement>(
			'a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
		);
		focusable.forEach((element) => {
			element.tabIndex = -1;
		});
	});
}

function PanelIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke="currentColor" />
			<path d="M11 3v10" stroke="currentColor" />
		</svg>
	);
}

function SearchIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="7" cy="7" r="3.4" stroke="currentColor" strokeWidth="1.3" />
			<path d="m9.6 9.6 2.5 2.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.3" />
		</svg>
	);
}

function PanelLeftIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
			<path d="M6.5 3v10" stroke="currentColor" strokeWidth="1.3" />
		</svg>
	);
}

function ArrowLeftIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path
				d="M12.5 8H3.5M7 4.5 3.5 8 7 11.5"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.3"
			/>
		</svg>
	);
}

function ArrowRightIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path
				d="M3.5 8h9M9 4.5 12.5 8 9 11.5"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.3"
			/>
		</svg>
	);
}

function BranchIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="4" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
			<circle cx="4" cy="12.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
			<circle cx="12" cy="12.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
			<path d="M4 5v6M8 3.5h1.5A2.5 2.5 0 0 1 12 6v5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.2" />
			<path d="m7.5 1.8 1.8 1.7-1.8 1.8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" />
		</svg>
	);
}

function LayoutGridIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
			<rect x="9" y="2.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
			<rect x="2.5" y="9" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
			<rect x="9" y="9" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
		</svg>
	);
}

function OrchestratorIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="8" cy="3" r="1.4" stroke="currentColor" strokeWidth="1.2" />
			<circle cx="3.5" cy="13" r="1.4" stroke="currentColor" strokeWidth="1.2" />
			<circle cx="8" cy="13" r="1.4" stroke="currentColor" strokeWidth="1.2" />
			<circle cx="12.5" cy="13" r="1.4" stroke="currentColor" strokeWidth="1.2" />
			<path d="M8 4.4v7.2M3.5 7.5h9M3.5 7.5v4.1M12.5 7.5v4.1" stroke="currentColor" strokeLinecap="round" strokeWidth="1.2" />
		</svg>
	);
}

function MoreVerticalIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="8" cy="3.5" r="1.1" fill="currentColor" />
			<circle cx="8" cy="8" r="1.1" fill="currentColor" />
			<circle cx="8" cy="12.5" r="1.1" fill="currentColor" />
		</svg>
	);
}

function PlusIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
		</svg>
	);
}

function BellIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path
				d="M8 13.75a1.5 1.5 0 0 0 1.5-1.35H6.5A1.5 1.5 0 0 0 8 13.75ZM3.75 11.75h8.5l-.9-1.45V7.1a3.35 3.35 0 0 0-6.7 0v3.2l-.9 1.45Z"
				stroke="currentColor"
				strokeLinejoin="round"
				strokeWidth="1.25"
			/>
		</svg>
	);
}

function BeakerIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path
				d="M6 2.5h4M7 2.5v3.1l-3.1 5.2A1.8 1.8 0 0 0 5.5 13.5h5A1.8 1.8 0 0 0 12.1 10.8L9 5.6V2.5"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.2"
			/>
		</svg>
	);
}

function CheckIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path d="m3.2 8.2 3.1 3.1 6.5-6.6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
		</svg>
	);
}

function WarningIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path d="M8 2.3 14 13H2L8 2.3Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.4" />
			<path d="M8 6.2v3.2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
			<path d="M8 11.7h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
		</svg>
	);
}

function WaitingIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" />
			<path d="M6.3 5.8v4.4M9.7 5.8v4.4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
		</svg>
	);
}

function SettingsIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
			<path
				d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.52a2 2 0 0 1-1 1.72l-.15.1a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.52a2 2 0 0 1 1-1.72l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.8"
			/>
			<circle
				cx="12"
				cy="12"
				r="3"
				stroke="currentColor"
				strokeWidth="1.2"
			/>
		</svg>
	);
}

function PinIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
			<path
				d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1z"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.75"
			/>
		</svg>
	);
}

function FolderOpenIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
			<path
				d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.75"
			/>
		</svg>
	);
}

function ChevronRightIcon({ className = "", expanded = false }: { className?: string; expanded?: boolean }) {
	return (
		<svg
			className={`${className}${expanded ? " rotate-90" : ""}`}
			viewBox="0 0 16 16"
			fill="none"
			aria-hidden="true"
		>
			<path
				d="M6 3.5 10.5 8 6 12.5"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="2"
			/>
		</svg>
	);
}

function ProjectActionIcon({
	children,
	className = "",
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<span
			className={`relative z-20 grid size-4 shrink-0 place-items-center text-[var(--preview-passive)] ${className}`}
		>
			{children}
		</span>
	);
}

const pinnedItems = [
	{ id: "pin-review", label: "landing review", color: STATUS_COLORS.inReview },
	{ id: "pin-merge", label: "ready to merge", color: STATUS_COLORS.ready },
] as const;

function SidebarSessionRow({
	active,
	dotColor,
	label,
	onClick,
}: {
	active?: boolean;
	dotColor: string;
	label: string;
	onClick?: () => void;
}) {
	return (
		<div className="pl-7">
			<button
				type="button"
				onClick={onClick}
				className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] outline-none transition-colors ${
					active
						? "bg-[var(--preview-sidebar-accent)] font-medium text-[var(--preview-foreground)]"
						: "text-[var(--preview-muted-foreground)] hover:bg-[var(--preview-sidebar-hover)] hover:text-[var(--preview-foreground)]"
				}`}
			>
				<span
					aria-hidden="true"
					className="mt-px h-1.5 w-1.5 shrink-0 rounded-full"
					style={{ backgroundColor: dotColor }}
				/>
				<span className="min-w-0 flex-1 truncate">{label}</span>
			</button>
		</div>
	);
}

function Sidebar({
	onResizeStart,
	onSelectTrack,
	onTitlebarPointerDown,
	sidebarRef,
	trackCards,
}: {
	onResizeStart: (clientX: number) => void;
	onSelectTrack: (trackId: TrackId) => void;
	onTitlebarPointerDown: (clientX: number, clientY: number) => void;
	sidebarRef: React.RefObject<HTMLElement | null>;
	trackCards: Record<TrackId, PreviewCard[]>;
}) {
	return (
		<aside
			ref={sidebarRef}
			className="relative flex shrink-0 flex-col bg-[var(--preview-sidebar)] text-[var(--preview-muted-foreground)]"
			style={{ width: SIDEBAR_DEFAULT_WIDTH }}
		>
			{/* Traffic lights + nav — taller row; lights share the same h-6 center box as the buttons. */}
			<div
				className="flex h-11 cursor-grab items-center gap-2 px-3 active:cursor-grabbing"
				onPointerDown={(event) => {
					if ((event.target as HTMLElement).closest("button")) return;
					event.preventDefault();
					onTitlebarPointerDown(event.clientX, event.clientY);
				}}
			>
				<div className="flex h-6 items-center gap-1.5">
					<span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#ff5f57]" />
					<span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#ffbd2e]" />
					<span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#28c840]" />
				</div>
				<button
					type="button"
					aria-label="Collapse sidebar"
					className="grid h-6 w-6 shrink-0 place-items-center text-[var(--preview-passive)]"
				>
					<PanelLeftIcon className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					aria-label="Go back"
					className="grid h-6 w-6 shrink-0 place-items-center text-[var(--preview-passive)] opacity-45"
				>
					<ArrowLeftIcon className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					aria-label="Go forward"
					className="grid h-6 w-6 shrink-0 place-items-center text-[var(--preview-passive)] opacity-45"
				>
					<ArrowRightIcon className="h-3.5 w-3.5" />
				</button>
			</div>

			{/* Brand left edge lines up with the red traffic light (same px-3). */}
			<div className="flex shrink-0 items-center gap-1.5 px-3 pb-2 pt-0.5">
				<img
					src="/ao-logo.svg"
					alt=""
					width={20}
					height={20}
					aria-hidden="true"
					className="h-5 w-5 shrink-0 rounded-md"
					draggable="false"
				/>
				<div className="min-w-0 flex-1 truncate text-[12px] font-bold leading-tight tracking-tight text-[var(--preview-sidebar-foreground)]">
					Agent Orchestrator
				</div>
			</div>

			<div className="flex shrink-0 flex-col px-2">
				<div className="pb-3">
					<div className="flex h-7 w-full items-center gap-2 rounded-lg bg-[var(--preview-muted)] px-2.5 text-[12px] font-normal text-[var(--preview-muted-foreground)]">
						<SearchIcon className="h-3 w-3 shrink-0 opacity-80" />
						<span className="min-w-0 flex-1 truncate leading-none">Search</span>
					</div>
				</div>

				{/* Pinned — compact section + a couple of session-style rows. */}
				<div className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-[var(--preview-passive)]">
					<PinIcon className="h-3.5 w-3.5 shrink-0" />
					<span className="min-w-0 truncate">Pinned</span>
					<ChevronRightIcon expanded className="h-3 w-3 shrink-0" />
				</div>
				<div className="mb-1 ml-2 flex flex-col gap-px">
					{pinnedItems.map((item) => (
						<SidebarSessionRow key={item.id} dotColor={item.color} label={item.label} />
					))}
				</div>

				{/* Projects — plus only; no disclosure chevron beside it. */}
				<div className="mb-0.5 flex h-7 w-full items-center gap-1.5 rounded-md px-2 pr-1 text-[12px] font-medium text-[var(--preview-passive)]">
					<FolderOpenIcon className="h-3.5 w-3.5 shrink-0" />
					<span className="min-w-0 flex-1 truncate">Projects</span>
					<span
						aria-hidden="true"
						className="grid h-4 w-4 shrink-0 place-items-center text-[var(--preview-passive)]"
					>
						<PlusIcon className="h-3.5 w-3.5" />
					</span>
				</div>
			</div>

			<div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2">
				<div className="relative z-20 mb-px shrink-0">
					{/* Project row — selected accent pill; foreground text matches real app. */}
					<div className="relative flex h-8 w-full items-center gap-2 rounded-lg bg-[var(--preview-sidebar-accent)] px-2 pr-[72px] text-left text-[12px] font-medium text-[var(--preview-foreground)]">
						<FolderOpenIcon className="h-3.5 w-3.5 shrink-0" />
						<span className="min-w-0 flex-1 truncate">agent-orchestrator</span>
					</div>
					<div className="absolute inset-y-0 right-1.5 z-30 flex items-center gap-px">
						<ProjectActionIcon>
							<LayoutGridIcon className="h-3 w-3" />
						</ProjectActionIcon>
						<ProjectActionIcon>
							<OrchestratorIcon className="h-3 w-3" />
						</ProjectActionIcon>
						<ProjectActionIcon>
							<MoreVerticalIcon className="h-3 w-3" />
						</ProjectActionIcon>
					</div>
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto py-0.5 scrollbar-hide">
					<div className="ml-2 flex flex-col gap-px">
						{projectItems.map((item) => (
							<SidebarSessionRow
								key={item.id}
								dotColor={trackDotColor(trackCards[item.id] ?? [])}
								label={item.label}
								onClick={() => onSelectTrack(item.id)}
							/>
						))}
					</div>
				</div>
			</div>

			{/* Settings — mb is panel inset (2px) + panel border (1px) so this hairline meets Archive's. */}
			<div className="mt-auto mb-[3px] flex h-13 shrink-0 items-center border-t border-[var(--preview-border-strong)] px-2">
				<div className="flex h-full w-full items-center gap-2 px-2 text-[12px] font-medium text-[var(--preview-muted-foreground)]">
					<SettingsIcon className="h-3.5 w-3.5 shrink-0" />
					<span>Settings</span>
				</div>
			</div>

			<div
				className="absolute right-0 top-0 bottom-0 z-10 w-[6px] cursor-col-resize group"
				onPointerDown={(event) => {
					event.preventDefault();
					event.stopPropagation();
					onResizeStart(event.clientX);
				}}
			>
				<div className="absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 bg-[var(--preview-muted-foreground)]/0 transition-colors group-hover:bg-[var(--preview-muted-foreground)]/25" />
			</div>
		</aside>
	);
}

function ArchiveBar({ count }: { count: number }) {
	return (
		<div className="flex h-13 shrink-0 items-center border-t border-[var(--preview-border-strong)] px-3">
			<button
				type="button"
				className="group inline-flex h-full w-full items-center gap-2 text-[11px] text-[var(--preview-muted-foreground)] transition-colors hover:text-[var(--preview-foreground)]"
			>
				<svg
					aria-hidden="true"
					className="h-3 w-3 shrink-0 text-[var(--preview-passive)]"
					viewBox="0 0 16 16"
					fill="none"
				>
					<path
						d="M6 4l4 4-4 4"
						stroke="currentColor"
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth="1.5"
					/>
				</svg>
				<span className="font-mono text-[10px] font-medium uppercase tracking-[0.04em]">Archive</span>
				<span className="font-mono tabular-nums text-[var(--preview-passive)]">{count}</span>
			</button>
		</div>
	);
}

function BoardChrome({
	onNewTask,
	viewMode,
}: {
	onNewTask: () => void;
	viewMode: ViewMode;
}) {
	return (
		<div className="flex h-12 shrink-0 items-center gap-2 px-4">
			<div className="min-w-0 truncate text-[13px] font-semibold tracking-tight text-[var(--preview-foreground)]">
				{viewMode === "orchestrator" ? "Orchestrator" : "agent-orchestrator"}
			</div>
			<div className="min-w-0 flex-1" />
			<button
				type="button"
				className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-[rgb(255_255_255/0.18)] text-[var(--preview-muted-foreground)] transition-colors hover:bg-[var(--preview-sidebar-hover)] hover:text-[var(--preview-foreground)]"
				aria-label="Notifications"
			>
				<BellIcon className="h-4 w-4" />
			</button>
			<button
				type="button"
				onClick={onNewTask}
				className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--preview-border)] bg-[var(--preview-raised)] px-3 text-[12px] font-semibold text-[var(--preview-muted-foreground)] transition-colors hover:bg-[var(--preview-card)] hover:text-[var(--preview-foreground)] active:scale-[0.98]"
			>
				<PlusIcon className="h-3.5 w-3.5" />
				<span>New task</span>
			</button>
			<button
				type="button"
				className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--preview-primary)] px-3 text-[12px] font-semibold text-[var(--preview-primary-foreground)] transition-[filter,transform] hover:brightness-110 active:scale-[0.98]"
			>
				<OrchestratorIcon className="h-3.5 w-3.5" />
				Orchestrator
			</button>
		</div>
	);
}

function BoardCard({
	card,
	onMerge,
}: {
	card: PreviewCard;
	onMerge: (id: string) => void;
}) {
	const statusColor = cardStatusColor(card);
	const statusLabel =
		card.column === "working"
			? card.activityState === "running"
				? "Working"
				: "Idle"
			: card.activity;

	return (
		<motion.div
			layout
			layoutId={`${card.id}-${card.column}`}
			initial={{ opacity: 0, scale: 0.98, y: -8 }}
			animate={
				card.merging
					? { opacity: 0, scale: 0.96, y: -8 }
					: { opacity: 1, scale: 1, y: 0 }
			}
			exit={{ opacity: 0, scale: 0.96, y: -8 }}
			transition={{
				duration: 0.45,
				ease: [0.22, 1, 0.36, 1],
				layout: { duration: 0.55, ease: [0.22, 1, 0.36, 1] },
			}}
			className="group relative w-full rounded-lg border border-[var(--preview-border)] bg-[var(--preview-card)] text-left outline-none transition-[border-color,box-shadow] hover:border-[var(--preview-border-strong)]"
		>
			<div className="flex items-start gap-2.5 px-3.5 pb-2.5 pt-3">
				<img
					src={card.icon}
					alt=""
					width={16}
					height={16}
					aria-hidden="true"
					className="mt-0.5 h-4 w-4 shrink-0 rounded-[3px]"
					draggable="false"
				/>
				<div className="min-w-0 flex-1">
					<div className="line-clamp-2 overflow-hidden text-[12px] font-semibold leading-tight tracking-tight text-[var(--preview-card-foreground)]">
						{card.title}
					</div>
					<div className="mt-1.5 flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-[var(--preview-passive)]">
						<BranchIcon className="h-3 w-3 shrink-0" />
						<span className="truncate">{card.branch}</span>
					</div>
				</div>
			</div>
			<div aria-hidden="true" className="mx-3.5 my-px h-px bg-[var(--preview-border)]" />
			<div className="flex items-center justify-between gap-2 px-3.5 py-2">
				<span
					className="inline-flex min-w-0 items-center gap-1.5 truncate text-[10px] font-medium"
					style={{ color: statusColor }}
				>
					<span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: statusColor }} />
					{statusLabel}
				</span>
				{card.tone === "ready" ? (
					<button
						type="button"
						onClick={(event) => {
							event.stopPropagation();
							onMerge(card.id);
						}}
						className="inline-flex h-6 items-center justify-center whitespace-nowrap rounded-[5px] bg-white px-2 text-[10px] font-semibold text-black transition-transform active:scale-[0.96]"
					>
						Merge
					</button>
				) : (
					<span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-[var(--preview-passive)]">
						{card.time}
					</span>
				)}
			</div>
		</motion.div>
	);
}

function LaneLabel({
	color,
	label,
	compact = false,
}: {
	color: string;
	compact?: boolean;
	glow?: boolean;
	label: string;
}) {
	return (
		<span
			className={`inline-flex items-center gap-1 ${compact ? "shrink-0 whitespace-nowrap" : "min-w-0"}`}
			style={{ color }}
		>
			<span
				aria-hidden="true"
				className="h-[7px] w-[7px] shrink-0 rounded-full"
				style={{ backgroundColor: color }}
			/>
			<span className={compact ? "" : "truncate"}>{label}</span>
		</span>
	);
}

function SplitLaneHeader({
	left,
	right,
}: {
	left: { color: string; label: string };
	right: { color: string; label: string };
}) {
	return (
		<>
			<LaneLabel compact color={left.color} label={left.label} />
			<span className="shrink-0 text-[var(--preview-passive)]" aria-hidden="true">
				/
			</span>
			<LaneLabel compact color={right.color} label={right.label} />
		</>
	);
}

const columnHeaderTitleClass =
	"text-[12px] font-semibold uppercase leading-none tracking-[0.04em]";
const columnHeaderCountClass =
	"shrink-0 font-mono text-[11px] tabular-nums leading-none text-[var(--preview-passive)]";

function BoardColumnHeader({
	color,
	count,
	id,
	idleCount,
	title,
	workingCount,
}: {
	color: string;
	count: number;
	id: BoardColumnId;
	idleCount: number;
	title: string;
	workingCount: number;
}) {
	if (id === "working") {
		return (
			<div className="flex items-center gap-2 px-3 py-2.5">
				<div className={`flex min-w-0 flex-1 items-center gap-1 overflow-hidden ${columnHeaderTitleClass}`}>
					<SplitLaneHeader
						left={{ color: STATUS_COLORS.idle, label: "Idle" }}
						right={{ color: STATUS_COLORS.working, label: "Working" }}
					/>
				</div>
				<div className={`flex items-center gap-1 pl-2 ${columnHeaderCountClass}`}>
					<span>{idleCount}</span>
					<span aria-hidden="true">/</span>
					<span>{workingCount}</span>
				</div>
			</div>
		);
	}

	if (id === "merge") {
		return (
			<div className="flex items-center gap-2 px-3 py-2.5">
				<div className={`flex min-w-0 flex-1 items-center gap-1 overflow-hidden ${columnHeaderTitleClass}`}>
					<SplitLaneHeader
						left={{ color: STATUS_COLORS.ready, label: "Mergeable" }}
						right={{ color: STATUS_COLORS.merged, label: "Merged" }}
					/>
				</div>
				<div className={`flex items-center gap-1 pl-2 ${columnHeaderCountClass}`}>
					<span>{count}</span>
					<span aria-hidden="true">/</span>
					<span>0</span>
				</div>
			</div>
		);
	}

	return (
		<div className="flex items-center gap-2 px-3 py-2.5">
			<div className={`min-w-0 flex-1 overflow-hidden ${columnHeaderTitleClass}`}>
				<LaneLabel color={color} label={title} />
			</div>
			<div className={`pl-2 ${columnHeaderCountClass}`}>{count}</div>
		</div>
	);
}

function BoardColumnBody({
	cards,
	id,
	onMerge,
}: {
	cards: PreviewCard[];
	id: BoardColumnId;
	onMerge: (id: string) => void;
}) {
	const idleCards = id === "working" ? cards.filter(isIdleCard) : [];
	const workingCards = id === "working" ? cards.filter((card) => !isIdleCard(card)) : cards;
	const visibleCards = id === "working" ? [...idleCards, ...workingCards] : cards;

	return (
		<div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2.5 py-2 scrollbar-hide">
			<AnimatePresence initial={false}>
				{visibleCards.map((card) => (
					<BoardCard key={`${card.id}-${card.column}`} card={card} onMerge={onMerge} />
				))}
			</AnimatePresence>
		</div>
	);
}

function BoardGrid({
	columns,
	onMerge,
}: {
	columns: Array<{
		cards: PreviewCard[];
		count: number;
		id: BoardColumnId;
		title: string;
	}>;
	onMerge: (id: string) => void;
}) {
	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden">
			<div className="grid shrink-0 grid-cols-4 border-b border-[var(--preview-divider)]">
				{columns.map((column) => {
					const idleCards = column.id === "working" ? column.cards.filter(isIdleCard) : [];
					const workingCards =
						column.id === "working" ? column.cards.filter((card) => !isIdleCard(card)) : column.cards;

					return (
						<div key={`${column.title}-header`} className="min-w-0">
							<BoardColumnHeader
								color={COLUMN_COLORS[column.id]}
								count={column.count}
								id={column.id}
								idleCount={idleCards.length}
								title={column.title}
								workingCount={workingCards.length}
							/>
						</div>
					);
				})}
			</div>
			<div className="grid min-h-0 flex-1 grid-cols-4">
				{columns.map((column) => (
					<div key={`${column.title}-body`} className="flex min-h-0 min-w-0 flex-col">
						<BoardColumnBody cards={column.cards} id={column.id} onMerge={onMerge} />
					</div>
				))}
			</div>
		</div>
	);
}

function OrchestratorView({
	cards,
	onNewTask,
	selectedTrack,
}: {
	cards: PreviewCard[];
	onNewTask: () => void;
	selectedTrack: TrackItem;
}) {
	const activeCards = cards.filter((card) => !card.merging);
	const workingCards = activeCards.filter((card) => card.column === "working");
	const waitingCards = activeCards.filter((card) => card.column === "action");
	const readyCards = activeCards.filter((card) => card.column === "merge");
	const leadWorker = workingCards[0] ?? activeCards[0];

	return (
		<div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden bg-[var(--preview-background)] sm:grid-cols-[minmax(0,1.05fr)_minmax(260px,0.65fr)]">
			<section className="flex min-h-0 flex-col p-3 sm:border-r sm:border-[var(--preview-border)] sm:p-4">
				<div className="flex items-center gap-3">
					<div className="grid h-9 w-9 place-items-center rounded-[10px] border border-[var(--preview-border)] bg-[var(--preview-muted)] text-[var(--preview-foreground)]">
						<BeakerIcon className="h-5 w-5" />
					</div>
					<div className="min-w-0">
						<div className="text-[13px] font-semibold tracking-[-0.5px] text-[var(--preview-foreground)]">
							Agent Orchestrator
						</div>
						<div className="truncate text-[10px] text-[var(--preview-muted-foreground)]">
							Planning workers for {selectedTrack.label.toLowerCase()}
						</div>
					</div>
				</div>

				<div className="mt-5 rounded-[10px] border border-[var(--preview-border)] bg-[var(--preview-card)] p-4">
					<div className="mb-3 text-[11px] font-semibold tracking-[-0.5px] text-[var(--preview-muted-foreground)]">
						Current plan
					</div>
					<div className="space-y-3 text-[12px] leading-5 text-[var(--preview-foreground)]">
						<div className="flex gap-2">
							<CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#86efac]" />
							<span>Read project context and split the track into worker-sized branches.</span>
						</div>
						<div className="flex gap-2">
							<span className="mt-1 h-3 w-3 shrink-0 animate-spin rounded-full border border-[#4b5563] border-t-[#d1d5db]" />
							<span>
								Keep {workingCards.length || 1} worker{workingCards.length === 1 ? "" : "s"} moving while routing blockers back here.
							</span>
						</div>
						<div className="flex gap-2">
							<WaitingIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#fcd34d]" />
							<span>
								Escalate {waitingCards.length} decision{waitingCards.length === 1 ? "" : "s"} and queue {readyCards.length} approved PR{readyCards.length === 1 ? "" : "s"} for merge.
							</span>
						</div>
					</div>
				</div>

				<div className="mt-4 min-h-0 flex-1 rounded-[10px] border border-[var(--preview-border)] bg-[var(--preview-card)] p-4 font-mono text-[11px] leading-5 text-[var(--preview-muted-foreground)]">
					<div className="text-[var(--preview-muted-foreground)]">ao orchestrator</div>
					<div className="mt-3 text-[var(--preview-foreground)]">
						<span className="text-[#60a5fa]">track</span> {selectedTrack.id}
					</div>
					<div className="mt-2 text-[var(--preview-foreground)]">
						<span className="text-[#60a5fa]">next</span>{" "}
						{leadWorker ? `watch ${leadWorker.branch}` : "spawn first worker"}
					</div>
					<div className="mt-2 text-[var(--preview-muted-foreground)]">
						Workers report back here when checks fail, reviews arrive, or a branch is ready to land.
					</div>
				</div>
			</section>

			<aside className="hidden min-h-0 flex-col bg-[var(--preview-background)] p-4 sm:flex">
				<div className="text-[11px] font-semibold tracking-[-0.5px] text-[var(--preview-muted-foreground)]">
					Worker queue
				</div>
				<div className="mt-3 space-y-2 overflow-y-auto scrollbar-hide">
					{activeCards.slice(0, 4).map((card) => (
						<div key={card.id} className="rounded-[8px] border border-[var(--preview-border)] bg-[var(--preview-card)] p-3">
							<div className="flex items-center gap-2">
								<img
									src={card.icon}
									alt=""
									width={14}
									height={14}
									aria-hidden="true"
									className="h-3.5 w-3.5"
									draggable="false"
								/>
								<div className="min-w-0 flex-1 truncate text-[11px] font-medium text-[var(--preview-card-foreground)]">
									{card.title}
								</div>
							</div>
							<div className="mt-2 truncate font-mono text-[10px] text-[var(--preview-muted-foreground)]">
								{card.branch}
							</div>
						</div>
					))}
				</div>
				<button
					type="button"
					onClick={onNewTask}
					className="mt-4 inline-flex h-8 items-center justify-center gap-2 rounded-[8px] bg-[var(--preview-primary)] px-3 text-[12px] font-semibold text-[var(--preview-primary-foreground)] transition-transform active:scale-[0.96]"
				>
					<PlusIcon className="h-4 w-4" />
					Spawn worker
				</button>
			</aside>
		</div>
	);
}

export function AppMockup() {
	const [cardsByTrack, setCardsByTrack] = useState(createInitialCardsByTrack);
	const [mergedCounts, setMergedCounts] = useState<Record<TrackId, number>>({
		landing: 18,
		deploy: 11,
		stars: 24,
		icons: 16,
		footer: 9,
	});
	const [boardVersion, setBoardVersion] = useState(0);
	const [selectedTrackId, setSelectedTrackId] = useState<TrackId>("landing");
	const [viewMode, setViewMode] = useState<ViewMode>("board");
	const incomingIndexes = useRef<Record<TrackId, number>>({
		landing: 0,
		deploy: 0,
		stars: 0,
		icons: 0,
		footer: 0,
	});
	const windowRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const sidebarRef = useRef<HTMLElement>(null);
	const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH);
	const { startDrag, startResize } = useFloatingWindow(windowRef);
	useDecorativeSubtree(windowRef);

	// Keep the board at the design size and scale the whole chrome to the shell.
	// Shrinking the layout box itself reflows columns and clips Mergeable / Merge.
	// Shell resize is aspect-locked, so width/BASE_WIDTH fills both axes with no gaps.
	useLayoutEffect(() => {
		const outer = windowRef.current;
		const content = contentRef.current;
		if (!outer || !content) return;

		const syncScale = () => {
			const width = outer.clientWidth;
			if (width <= 0) return;
			content.style.transform = `scale(${width / BASE_WIDTH})`;
		};

		syncScale();
		const observer = new ResizeObserver(syncScale);
		observer.observe(outer);
		window.addEventListener("resize", syncScale);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", syncScale);
		};
	}, []);

	const selectedTrack =
		projectItems.find((item) => item.id === selectedTrackId) ?? projectItems[0];
	const cards = cardsByTrack[selectedTrackId];
	const mergedCount = mergedCounts[selectedTrackId];

	const updateTrackCards = useCallback(
		(trackId: TrackId, update: (cards: PreviewCard[]) => PreviewCard[]) => {
			setCardsByTrack((current) => ({
				...current,
				[trackId]: update(current[trackId]),
			}));
		},
		[],
	);

	const startSidebarResize = useCallback((clientX: number) => {
		const startWidth = sidebarWidthRef.current;
		const startX = clientX;

		const handleMove = (event: PointerEvent) => {
			const delta = event.clientX - startX;
			const nextWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, startWidth + delta));
			sidebarWidthRef.current = nextWidth;
			if (sidebarRef.current) {
				sidebarRef.current.style.width = `${nextWidth}px`;
			}
		};

		const handleUp = () => {
			window.removeEventListener("pointermove", handleMove);
			window.removeEventListener("pointerup", handleUp);
		};

		window.addEventListener("pointermove", handleMove);
		window.addEventListener("pointerup", handleUp);
	}, []);

	const mergeCard = useCallback((id: string) => {
		const trackId = selectedTrackId;
		updateTrackCards(trackId, (current) =>
			current.map((card) => (card.id === id ? { ...card, merging: true } : card)),
		);

		window.setTimeout(() => {
			updateTrackCards(trackId, (current) => current.filter((card) => card.id !== id));
			setMergedCounts((current) => ({
				...current,
				[trackId]: current[trackId] + 1,
			}));
		}, 520);
	}, [selectedTrackId, updateTrackCards]);

	const spawnRandomTask = useCallback(() => {
		setViewMode("board");
		const trackId = selectedTrackId;
		const incomingCards = incomingCardsByTrack[trackId];
		updateTrackCards(trackId, (current) => {
			const existingTitles = new Set(current.map((card) => card.title));
			const startIndex = Math.floor(Math.random() * incomingCards.length);
			const templateOffset = incomingCards.findIndex((_, offset) => {
				const candidate = incomingCards[(startIndex + offset) % incomingCards.length];
				return candidate ? !existingTitles.has(candidate.title) : false;
			});

			if (templateOffset < 0) return current;

			const templateIndex = (startIndex + templateOffset) % incomingCards.length;
			const template = incomingCards[templateIndex];
			if (!template) return current;

			incomingIndexes.current[trackId] += 1;
			return [
				{
					...template,
					badge: "New task",
					column: "working",
					activity: "Working",
					activityState: "running",
					id: `${trackId}-manual-${Date.now()}-${incomingIndexes.current[trackId]}`,
					time: "now",
				},
				...current,
			];
		});
	}, [selectedTrackId, updateTrackCards]);

	const selectTrack = useCallback((trackId: TrackId) => {
		setSelectedTrackId(trackId);
		setViewMode("board");
		setBoardVersion((current) => current + 1);
	}, []);

	useEffect(() => {
		let timeoutId: number;

		const scheduleNext = () => {
			timeoutId = window.setTimeout(runStep, randomDelay());
		};

		const runStep = () => {
			const trackId = selectedTrackId;
			const incomingCards = incomingCardsByTrack[trackId];
			updateTrackCards(trackId, (current) => {
				const chosen = randomItem(current.filter((card) => !card.merging));

				let next = current;
				if (chosen) {
					if (chosen.column === "merge") {
						window.setTimeout(() => mergeCard(chosen.id), 0);
					} else {
						next = current.map((card) =>
							card.id === chosen.id ? advanceCard(card) : card,
						);
					}
				}

				const workingCount = next.filter((card) => card.column === "working").length;
				const activeCount = next.filter((card) => !card.merging).length;
				if (workingCount < 2 && activeCount < 7 && Math.random() < 0.5) {
					const existingTitles = new Set(next.map((card) => card.title));
					const templateOffset = incomingCards.findIndex((_, offset) => {
						const candidate =
							incomingCards[
								(incomingIndexes.current[trackId] + offset) % incomingCards.length
							];
						return candidate ? !existingTitles.has(candidate.title) : false;
					});

					if (templateOffset >= 0) {
						const templateIndex =
							(incomingIndexes.current[trackId] + templateOffset) %
							incomingCards.length;
						const template = incomingCards[templateIndex];
						if (template) {
							incomingIndexes.current[trackId] = templateIndex + 1;
							next = [
								{
									...template,
									column: "working",
									activity: "Working",
									activityState: "running",
									id: `${trackId}-incoming-${incomingIndexes.current[trackId]}`,
								},
								...next,
							];
						}
					}
				}

				return next;
			});

			scheduleNext();
		};

		scheduleNext();
		return () => window.clearTimeout(timeoutId);
	}, [mergeCard, selectedTrackId, updateTrackCards]);

	const boardColumns = columns.map((column) => {
		const columnCards = cards.filter((card) => card.column === column.id);
		return {
			...column,
			cards: columnCards,
			count: columnCards.length,
		};
	});

	return (
		<div
			ref={windowRef}
			role="img"
			aria-label="Preview of the Agent Orchestrator board: agent tasks move across Idle, Working, Needs you, In review, and Ready to merge."
			className="absolute z-10 select-none overflow-hidden rounded-[20px] border border-[var(--preview-border)] bg-[var(--preview-sidebar)] font-sans tracking-tight text-[var(--preview-foreground)] antialiased shadow-[0_30px_80px_-24px_rgba(0,0,0,0.75)] [&_.font-mono]:tracking-normal"
			style={mockupShellStyle}
		>
			<div className="relative h-full w-full overflow-hidden">
				<div
					ref={contentRef}
					className="h-(--mockup-design-h) w-(--mockup-design-w) origin-top-left"
				>
					<div className="flex h-full min-h-0">
						<Sidebar
							onResizeStart={startSidebarResize}
							onSelectTrack={selectTrack}
							onTitlebarPointerDown={startDrag}
							sidebarRef={sidebarRef}
							trackCards={cardsByTrack}
						/>
						<div className="flex min-h-0 min-w-0 flex-1 flex-col p-[2px]">
							<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[17px] border border-[var(--preview-border-strong)] bg-[var(--preview-background)]">
								<BoardChrome
									onNewTask={spawnRandomTask}
									viewMode={viewMode}
								/>
								{viewMode === "orchestrator" ? (
									<OrchestratorView
										cards={cards}
										onNewTask={spawnRandomTask}
										selectedTrack={selectedTrack}
									/>
								) : (
									<>
										<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden border-t border-[var(--preview-divider)]">
											<div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10">
												<div className="absolute inset-y-0 left-1/4 w-px bg-[var(--preview-divider)]" />
												<div className="absolute inset-y-0 left-2/4 w-px bg-[var(--preview-divider)]" />
												<div className="absolute inset-y-0 left-3/4 w-px bg-[var(--preview-divider)]" />
											</div>
											<LayoutGroup key={`${selectedTrack.id}-${boardVersion}`}>
												<BoardGrid
													columns={boardColumns}
													onMerge={mergeCard}
												/>
											</LayoutGroup>
										</div>
										<ArchiveBar count={mergedCount} />
									</>
								)}
							</div>
						</div>
					</div>
				</div>
			</div>
			<ResizeHandles onResizeStart={startResize} />
		</div>
	);
}
