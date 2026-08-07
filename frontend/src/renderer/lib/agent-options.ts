export const AGENT_OPTIONS = [
	"claude-code",
	"codex",
	"aider",
	"opencode",
	"grok",
	"droid",
	"amp",
	"agy",
	"crush",
	"cursor",
	"qwen",
	"copilot",
	"goose",
	"auggie",
	"continue",
	"devin",
	"cline",
	"kimi",
	"kiro",
	"kilocode",
	"vibe",
	"pi",
	"autohand",
] as const;

export type AgentOption = (typeof AGENT_OPTIONS)[number];

export const AGENT_LABELS: Record<AgentOption, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	aider: "Aider",
	opencode: "OpenCode",
	grok: "Grok",
	droid: "Droid",
	amp: "Amp",
	agy: "AGY",
	crush: "Crush",
	cursor: "Cursor",
	qwen: "Qwen",
	copilot: "GitHub Copilot",
	goose: "Goose",
	auggie: "Auggie",
	continue: "Continue",
	devin: "Devin",
	cline: "Cline",
	kimi: "Kimi",
	kiro: "Kiro",
	kilocode: "Kilo Code",
	vibe: "Vibe",
	pi: "Pi",
	autohand: "Autohand",
};

export function agentLabel(provider: string): string {
	return provider in AGENT_LABELS ? AGENT_LABELS[provider as AgentOption] : provider;
}
