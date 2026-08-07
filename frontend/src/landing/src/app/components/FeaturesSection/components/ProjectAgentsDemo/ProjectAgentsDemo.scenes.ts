export type CursorTarget =
	| "modal"
	| "task-textarea"
	| "agent-trigger"
	| "agent-menu"
	| "agent-selected"
	| "model-trigger"
	| "start-button"
	| "board-card";

export type ProjectAgentsScene = {
	id: string;
	duration: number;
	target: CursorTarget;
	click?: boolean;
	phase: "modal" | "board";
	typing?: boolean;
	typedChars?: number;
	agentMenuOpen?: boolean;
	agentMenuHover?: string | null;
	selectedAgent?: string;
	busy?: boolean;
};

const TASK_TEXT = "Fix the flaky webhook retry test and add edge-case coverage for timeout scenarios";

export const TASK_TEXT_FULL = TASK_TEXT;

export const TYPING_INTERVAL_MS = 20;

export const PROJECT_AGENT_SCENES: readonly ProjectAgentsScene[] = [
	{ id: "modal-appear", duration: 1_200, target: "task-textarea", phase: "modal", typedChars: 0 },
	{ id: "typing", duration: TASK_TEXT.length * TYPING_INTERVAL_MS + 300, target: "task-textarea", phase: "modal", typing: true, typedChars: TASK_TEXT.length },
	// Open agent dropdown
	{ id: "agent-click", duration: 900, target: "agent-trigger", click: true, phase: "modal", typedChars: TASK_TEXT.length, agentMenuOpen: true },
	// Scroll down — cursor sits static inside the menu while highlights scroll
	{ id: "scroll-1", duration: 600, target: "agent-menu", phase: "modal", typedChars: TASK_TEXT.length, agentMenuOpen: true, agentMenuHover: "opencode" },
	{ id: "scroll-2", duration: 600, target: "agent-menu", phase: "modal", typedChars: TASK_TEXT.length, agentMenuOpen: true, agentMenuHover: "cline" },
	{ id: "scroll-3", duration: 600, target: "agent-menu", phase: "modal", typedChars: TASK_TEXT.length, agentMenuOpen: true, agentMenuHover: "continue" },
	{ id: "scroll-4", duration: 600, target: "agent-menu", phase: "modal", typedChars: TASK_TEXT.length, agentMenuOpen: true, agentMenuHover: "kimi" },
	{ id: "scroll-5", duration: 600, target: "agent-menu", phase: "modal", typedChars: TASK_TEXT.length, agentMenuOpen: true, agentMenuHover: "droid" },
	{ id: "scroll-6", duration: 600, target: "agent-menu", phase: "modal", typedChars: TASK_TEXT.length, agentMenuOpen: true, agentMenuHover: "crush" },
	{ id: "scroll-7", duration: 600, target: "agent-menu", phase: "modal", typedChars: TASK_TEXT.length, agentMenuOpen: true, agentMenuHover: "pi" },
	{ id: "scroll-8", duration: 800, target: "agent-menu", phase: "modal", typedChars: TASK_TEXT.length, agentMenuOpen: true, agentMenuHover: "agy" },
	// Click to pick
	{ id: "agent-pick", duration: 900, target: "agent-selected", click: true, phase: "modal", typedChars: TASK_TEXT.length, agentMenuOpen: true, agentMenuHover: "agy", selectedAgent: "agy" },
	// Click Start
	{ id: "start-hover", duration: 900, target: "start-button", phase: "modal", typedChars: TASK_TEXT.length, selectedAgent: "agy" },
	{ id: "start-click", duration: 1_200, target: "start-button", click: true, phase: "modal", typedChars: TASK_TEXT.length, selectedAgent: "agy", busy: true },
	// Board appears with created task
	{ id: "board-reveal", duration: 3_500, target: "board-card", phase: "board", selectedAgent: "agy" },
	// Reset
	{ id: "reset", duration: 800, target: "modal", phase: "modal", typedChars: 0 },
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
