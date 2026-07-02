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

// The agent new projects use by default, and the fallback for worker/orchestrator
// role fields that have no explicit configuration. Users can change it per project.
export const DEFAULT_PROJECT_AGENT: (typeof AGENT_OPTIONS)[number] = "claude-code";
