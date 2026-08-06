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
	{ id: "copilot", label: "GitHub Copilot", icon: "/app-icons/agents/copilot-color.svg", status: "", statusTone: "success", disabled: false },
	{ id: "cursor", label: "Cursor", icon: "/app-icons/agents/cursor.svg", status: "", statusTone: "success", disabled: false },
	{ id: "opencode", label: "OpenCode", icon: "/app-icons/agents/opencode.svg", status: "", statusTone: "success", disabled: false },
	{ id: "aider", label: "Aider", icon: "/app-icons/agents/aider.png", status: "", statusTone: "success", disabled: false },
	{ id: "goose", label: "Goose", icon: "/app-icons/agents/goose.svg", status: "", statusTone: "success", disabled: false },
	{ id: "cline", label: "Cline", icon: "/app-icons/agents/cline.svg", status: "", statusTone: "success", disabled: false },
	{ id: "kiro", label: "Kiro", icon: "/app-icons/agents/kiro.png", status: "", statusTone: "success", disabled: false },
	{ id: "amp", label: "Amp", icon: "/app-icons/agents/amp.svg", status: "", statusTone: "success", disabled: false },
	{ id: "continue", label: "Continue", icon: "/app-icons/agents/continue.png", status: "", statusTone: "success", disabled: false },
	{ id: "devin", label: "Devin", icon: "/app-icons/agents/devin.png", status: "", statusTone: "success", disabled: false },
	{ id: "grok", label: "Grok", icon: "/app-icons/agents/grok.png", status: "", statusTone: "success", disabled: false },
	{ id: "qwen", label: "Qwen Code", icon: "/app-icons/agents/qwen.png", status: "", statusTone: "success", disabled: false },
	{ id: "kimi", label: "Kimi", icon: "/app-icons/agents/kimi.png", status: "", statusTone: "success", disabled: false },
	{ id: "vibe", label: "Vibe", icon: "/app-icons/agents/vibe.png", status: "", statusTone: "success", disabled: false },
	{ id: "auggie", label: "Auggie", icon: "/app-icons/agents/auggie.svg", status: "", statusTone: "success", disabled: false },
	{ id: "droid", label: "Droid", icon: "/app-icons/agents/droid.png", status: "", statusTone: "success", disabled: false },
	{ id: "kilocode", label: "Kilocode", icon: "/app-icons/agents/kilocode.png", status: "", statusTone: "success", disabled: false },
	{ id: "crush", label: "Crush", icon: "/app-icons/agents/crush.png", status: "", statusTone: "success", disabled: false },
	{ id: "autohand", label: "Autohand", icon: "/app-icons/agents/autohand.svg", status: "", statusTone: "success", disabled: false },
	{ id: "pi", label: "Pi", icon: "/app-icons/agents/pi.png", status: "", statusTone: "success", disabled: false },
	{ id: "agy", label: "Agy", icon: "/app-icons/agents/agy.png", status: "", statusTone: "success", disabled: false },
] as const;
