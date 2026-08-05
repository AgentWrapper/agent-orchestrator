export type ProjectAgentMenuOption = {
	id: string;
	label: string;
	icon: string;
	status: "" | "Auth unknown" | "Needs auth" | "Needs install";
	statusTone: "success" | "warning" | "muted";
	disabled: boolean;
};

export const PROJECT_AGENT_MENU_OPTIONS: readonly ProjectAgentMenuOption[] = [
	{ id: "claude-code", label: "Claude Code", icon: "/app-icons/agents/claude-code.svg", status: "", statusTone: "success", disabled: false },
	{ id: "codex", label: "Codex", icon: "/app-icons/agents/codex.svg", status: "", statusTone: "success", disabled: false },
	{ id: "copilot", label: "GitHub Copilot", icon: "/app-icons/agents/copilot.png", status: "", statusTone: "success", disabled: false },
	{ id: "qwen", label: "Qwen Code", icon: "/app-icons/agents/qwen.png", status: "Auth unknown", statusTone: "warning", disabled: false },
	{ id: "kimi", label: "Kimi", icon: "/app-icons/agents/kimi.png", status: "Needs auth", statusTone: "warning", disabled: true },
	{ id: "cursor", label: "Cursor", icon: "/app-icons/agents/cursor.svg", status: "Needs install", statusTone: "muted", disabled: true },
] as const;

export const PROJECT_AGENTS_VISUAL_CONTRACT = {
	importPicker: {
		width: 548,
		panelPadding: 20,
		panelGap: 20,
		cardGap: 15,
		cardMinHeight: 178,
		cardPadding: 15,
		cardPaddingBottom: 20,
		illustrationHeight: 109,
		descriptionMinHeight: 28,
	},
	agentSelect: {
		triggerHeight: 32,
		menuOffset: 4,
		menuTop: 78,
		itemPaddingX: 8,
		itemPaddingY: 5,
		contentGap: 10,
		menuIconSize: 14,
		menuMaxHeight: 176,
		trailingColumnWidth: 76,
		clickFeedback: false,
		sidebarChromeHeight: 40,
		contentHeaderHeight: 40,
		sidebarBrandRowHeight: 30,
		workspaceRepoRowPaddingY: 3,
		workspaceRepoListGap: 4,
		workspaceIllustrationPaddingBottom: 12,
		activeTriggerGlow: false,
		showsSelectedCheck: false,
	},
} as const;