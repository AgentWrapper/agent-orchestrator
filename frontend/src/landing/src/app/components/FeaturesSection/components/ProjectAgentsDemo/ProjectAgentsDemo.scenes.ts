export type ProjectAgentId = "codex" | "cursor" | "claude-code";

export type CursorTarget =
	| "board-idle"
	| "project-row"
	| "project-actions"
	| "project-settings"
	| "worker-trigger"
	| "worker-cursor"
	| "orchestrator-trigger"
	| "orchestrator-claude"
	| "save";

export type ProjectAgentsScene = {
	id: string;
	duration: number;
	target: CursorTarget;
	view: "board" | "settings";
	worker: ProjectAgentId;
	orchestrator: ProjectAgentId;
	click?: boolean;
	projectHover?: boolean;
	actionsMenu?: boolean;
	openMenu?: "worker" | "orchestrator";
	hoverAgent?: ProjectAgentId;
	saveState?: "idle" | "saving" | "saved";
	reset?: boolean;
};

const BOARD_DEFAULTS = {
	view: "board",
	worker: "codex",
	orchestrator: "codex",
} as const;

const SETTINGS_DEFAULTS = {
	view: "settings",
	worker: "codex",
	orchestrator: "codex",
	saveState: "idle",
} as const;

export const PROJECT_AGENT_SCENES: readonly ProjectAgentsScene[] = [
	{ id: "board-idle", duration: 900, target: "board-idle", ...BOARD_DEFAULTS },
	{
		id: "project-hover",
		duration: 700,
		target: "project-row",
		projectHover: true,
		...BOARD_DEFAULTS,
	},
	{
		id: "actions-click",
		duration: 450,
		target: "project-actions",
		click: true,
		projectHover: true,
		...BOARD_DEFAULTS,
	},
	{
		id: "settings-click",
		duration: 1_100,
		target: "project-settings",
		click: true,
		projectHover: true,
		actionsMenu: true,
		...BOARD_DEFAULTS,
	},
	{ id: "settings-open", duration: 850, target: "worker-trigger", ...SETTINGS_DEFAULTS },
	{
		id: "worker-click",
		duration: 450,
		target: "worker-trigger",
		click: true,
		openMenu: "worker",
		...SETTINGS_DEFAULTS,
	},
	{
		id: "worker-hover",
		duration: 650,
		target: "worker-cursor",
		openMenu: "worker",
		hoverAgent: "cursor",
		...SETTINGS_DEFAULTS,
	},
	{
		id: "worker-pick",
		duration: 450,
		target: "worker-cursor",
		click: true,
		openMenu: "worker",
		hoverAgent: "cursor",
		...SETTINGS_DEFAULTS,
		worker: "cursor",
	},
	{
		id: "orchestrator-click",
		duration: 650,
		target: "orchestrator-trigger",
		click: true,
		openMenu: "orchestrator",
		...SETTINGS_DEFAULTS,
		worker: "cursor",
	},
	{
		id: "orchestrator-hover",
		duration: 650,
		target: "orchestrator-claude",
		openMenu: "orchestrator",
		hoverAgent: "claude-code",
		...SETTINGS_DEFAULTS,
		worker: "cursor",
	},
	{
		id: "orchestrator-pick",
		duration: 450,
		target: "orchestrator-claude",
		click: true,
		openMenu: "orchestrator",
		hoverAgent: "claude-code",
		...SETTINGS_DEFAULTS,
		worker: "cursor",
		orchestrator: "claude-code",
	},
	{
		id: "save-hover",
		duration: 700,
		target: "save",
		...SETTINGS_DEFAULTS,
		worker: "cursor",
		orchestrator: "claude-code",
	},
	{
		id: "save-click",
		duration: 450,
		target: "save",
		click: true,
		...SETTINGS_DEFAULTS,
		worker: "cursor",
		orchestrator: "claude-code",
	},
	{
		id: "saving",
		duration: 900,
		target: "save",
		...SETTINGS_DEFAULTS,
		worker: "cursor",
		orchestrator: "claude-code",
		saveState: "saving",
	},
	{
		id: "saved",
		duration: 1_800,
		target: "save",
		...SETTINGS_DEFAULTS,
		worker: "cursor",
		orchestrator: "claude-code",
		saveState: "saved",
	},
	{
		id: "reset",
		duration: 500,
		target: "board-idle",
		reset: true,
		...BOARD_DEFAULTS,
	},
];

export const SAVED_PROJECT_AGENT_SCENE = PROJECT_AGENT_SCENES.find(
	(scene) => scene.saveState === "saved",
)!;

type Rect = Pick<DOMRect, "left" | "top" | "width" | "height">;

export function cursorPositionForRects(root: Rect, target: Rect) {
	return {
		x: ((target.left + target.width / 2 - root.left) / root.width) * 100,
		y: ((target.top + target.height / 2 - root.top) / root.height) * 100,
	};
}
