export type CursorTarget =
	| "board-idle"
	| "new-project"
	| "new-project-row"
	| "mode-picker"
	| "project-kind"
	| "modal"
	| "worker-trigger"
	| "worker-cursor"
	| "orchestrator-trigger"
	| "orchestrator-claude"
	| "create-and-start";

export type ProjectAgentsScene = {
	id: string;
	duration: number;
	target: CursorTarget;
	click?: boolean;
	newProjectHover?: boolean;
	modePicker?: boolean;
	modal?: boolean;
	openMenu?: "worker" | "orch" | null;
	menuHover?: string | null;
	worker: string;
	orch: string;
	busy?: boolean;
	created?: boolean;
	reset?: boolean;
};

const IDLE = { worker: "codex", orch: "codex" } as const;

export const PROJECT_AGENT_SCENES: readonly ProjectAgentsScene[] = [
	{ id: "board-idle", duration: 900, target: "board-idle", ...IDLE },
	{ id: "new-project-hover", duration: 600, target: "new-project", newProjectHover: true, ...IDLE },
	{ id: "new-project-click", duration: 450, target: "new-project", click: true, newProjectHover: true, ...IDLE },
	{ id: "mode-picker-open", duration: 700, target: "mode-picker", modePicker: true, ...IDLE },
	{ id: "project-kind-click", duration: 700, target: "project-kind", click: true, modePicker: true, ...IDLE },
	{ id: "modal-open", duration: 700, target: "modal", modal: true, ...IDLE },
	{ id: "worker-open", duration: 600, target: "worker-trigger", modal: true, click: true, openMenu: "worker", ...IDLE },
	{ id: "worker-hover", duration: 650, target: "worker-cursor", modal: true, openMenu: "worker", menuHover: "cursor", ...IDLE },
	{ id: "worker-pick", duration: 450, target: "worker-cursor", modal: true, click: true, openMenu: "worker", menuHover: "cursor", worker: "cursor", orch: "codex" },
	{ id: "orch-open", duration: 600, target: "orchestrator-trigger", modal: true, click: true, openMenu: "orch", worker: "cursor", orch: "codex" },
	{ id: "orch-hover", duration: 650, target: "orchestrator-claude", modal: true, openMenu: "orch", menuHover: "claude-code", worker: "cursor", orch: "codex" },
	{ id: "orch-pick", duration: 450, target: "orchestrator-claude", modal: true, click: true, openMenu: "orch", menuHover: "claude-code", worker: "cursor", orch: "claude-code" },
	{ id: "create-hover", duration: 550, target: "create-and-start", modal: true, worker: "cursor", orch: "claude-code" },
	{ id: "creating", duration: 900, target: "create-and-start", modal: true, click: true, busy: true, worker: "cursor", orch: "claude-code" },
	{ id: "created", duration: 1_300, target: "new-project-row", modal: false, created: true, worker: "cursor", orch: "claude-code" },
	{ id: "reset", duration: 550, target: "board-idle", reset: true, ...IDLE },
];

export function sceneClockKey(scene: Pick<ProjectAgentsScene, "id">) {
	return scene.id;
}

type Rect = Pick<DOMRect, "left" | "top" | "width" | "height">;

export function cursorPositionForRects(root: Rect, target: Rect) {
	return {
		x: ((target.left + target.width / 2 - root.left) / root.width) * 100,
		y: ((target.top + target.height / 2 - root.top) / root.height) * 100,
	};
}
