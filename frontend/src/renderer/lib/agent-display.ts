import { AGENT_OPTIONS } from "./agent-options";
import type { AgentProvider } from "../types/workspace";

const AGENT_IDS = new Set<string>(AGENT_OPTIONS);

/**
 * Short tab/chip label for an agent harness, matching common brand short names
 * (claude, not claude-code).
 */
export function agentTabLabel(provider: AgentProvider): string {
	switch (provider) {
		case "claude-code":
			return "claude";
		case "opencode":
			return "opencode";
		case "fake":
			return "fake";
		default:
			return provider;
	}
}

/** Resolve a harness id from a free-form string when it matches a known agent. */
export function parseAgentProvider(raw: string | undefined): AgentProvider | undefined {
	const trimmed = raw?.trim().toLowerCase() ?? "";
	if (!trimmed) return undefined;
	if (trimmed === "claude") return "claude-code";
	if (AGENT_IDS.has(trimmed)) return trimmed as AgentProvider;
	return undefined;
}

/** True when the tab title is still the auto cwd basename (or generic Shell). */
function isDefaultShellTitle(title: string, workingDir: string): boolean {
	return title === defaultShellTitle(workingDir) || title === "Shell";
}

/**
 * Sniff an agent CLI's startup banner out of live pane text.
 *
 * Only distinctive banner phrases count. A bare binary name would also match
 * the command the user merely typed at the prompt (or one still sitting in
 * scrollback), which is how a tab used to get stuck on the wrong agent.
 * Mirrors agentBannerRules in backend/internal/service/shellterm/detect.go.
 */
export function detectAgentFromText(raw: string): AgentProvider | undefined {
	const lower = stripAnsi(raw).toLowerCase();
	if (!lower) return undefined;
	for (const rule of AGENT_BANNER_RULES) {
		if (lower.includes(rule.needle)) return rule.agent;
	}
	return undefined;
}

const AGENT_BANNER_RULES: { needle: string; agent: AgentProvider }[] = [
	{ needle: "welcome to kimi", agent: "kimi" },
	{ needle: "kimi code", agent: "kimi" },
	{ needle: "claude code", agent: "claude-code" },
	{ needle: "openai codex", agent: "codex" },
	{ needle: "cursor agent", agent: "cursor" },
	{ needle: "github copilot", agent: "copilot" },
	{ needle: "aider v", agent: "aider" },
];

/**
 * True when the most recent output ends back at an interactive shell prompt,
 * i.e. nothing is running in the pane. Used to forget a previously detected
 * agent the moment the user quits it, so the next one can be picked up.
 */
export function looksLikeShellPrompt(raw: string): boolean {
	const lines = stripAnsi(raw).split(/\r?\n/);
	const last = lines[lines.length - 1]?.trimEnd() ?? "";
	if (!last) return false;
	// Either a themed prompt glyph (oh-my-zsh, starship, fish) anywhere in the
	// line, or a plain sh/bash/zsh prompt ending in $ / % / #. The line may
	// already carry a half-typed command, which still means "no agent running".
	return /[➜❯»]/.test(last) || /(?:^|\s)[$%#]\s*\S*$/.test(last);
}

/** Terminals that repaint a full-screen TUI leave the alternate screen on exit. */
export function leftAlternateScreen(raw: string): boolean {
	return /\u001b\[\?(?:1049|1047|47)l/.test(raw);
}

function stripAnsi(value: string): string {
	return value
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
}

/**
 * Label + provider for a shell tab.
 *
 * - Agent running → its brand + logo
 * - User-renamed tab → that text, plus the logo of whatever is running
 * - Plain shell → cwd title, no logo
 *
 * A title that is itself an agent brand is treated as branding rather than a
 * rename, so the tab follows the pane instead of staying on the agent that
 * happened to run in it first.
 */
export function shellTabPresentation(input: {
	title: string;
	workingDir: string;
	detectedAgent?: string;
}): { label: string; provider?: AgentProvider } {
	const provider = parseAgentProvider(input.detectedAgent);
	const titleIsBranding = isDefaultShellTitle(input.title, input.workingDir) || Boolean(parseAgentProvider(input.title));

	if (provider) {
		return { label: titleIsBranding ? agentTabLabel(provider) : input.title, provider };
	}
	return { label: titleIsBranding ? defaultShellTitle(input.workingDir) : input.title };
}

function defaultShellTitle(workingDir: string): string {
	const trimmed = workingDir.replace(/[/\\]+$/, "");
	const base = trimmed.split(/[/\\]/).pop() ?? "";
	if (!base || base === ".") return "Shell";
	return base;
}
