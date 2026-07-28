import aiderLogo from "../assets/agents/aider.png";
import ampLogo from "../assets/agents/amp.svg";
import claudeLogo from "../assets/agents/claude.svg";
import claudeCodeLogo from "../assets/agents/claude-code.svg";
import clineLogo from "../assets/agents/cline.svg";
import codexLogo from "../assets/agents/codex.svg";
import continueLogo from "../assets/agents/continue.png";
import copilotLogo from "../assets/agents/copilot.svg";
import crushLogo from "../assets/agents/crush.png";
import cursorLogo from "../assets/agents/cursor.svg";
import devinLogo from "../assets/agents/devin.svg";
import droidLogo from "../assets/agents/droid.png";
import gooseLogo from "../assets/agents/goose.svg";
import grokLogo from "../assets/agents/grok.svg";
import kilocodeLogo from "../assets/agents/kilocode.svg";
import kimiLogo from "../assets/agents/kimi.svg";
import kiroLogo from "../assets/agents/kiro.svg";
import opencodeLogo from "../assets/agents/opencode.svg";
import piLogo from "../assets/agents/pi.svg";
import qwenLogo from "../assets/agents/qwen.png";
import vibeLogo from "../assets/agents/vibe.png";

/**
 * How a mark has to be painted to survive both themes.
 *
 * - `colour` — the art carries its own palette and has enough contrast either
 *   way (orange, a gradient, a two-tone greyscale). Drawn as-is.
 * - `mono` — a single-colour silhouette. Drawn as a mask filled with
 *   `currentColor`, so it takes the board foreground and flips with the theme
 *   instead of disappearing into one of them.
 *
 * No mark carries a background plate: a logo sitting on its own brand-coloured
 * tile fights every surface it lands on, so plates are stripped from the asset
 * rather than hidden with CSS.
 */
export type AgentLogoPaint = "colour" | "mono";

export type AgentLogo = {
	/** Resolved asset URL (Vite rewrites these at build time). */
	src: string;
	paint: AgentLogoPaint;
};

/**
 * Every agent mark AO ships, keyed by the harness name the daemon stores on
 * `session.provider`.
 *
 * This is the single source of truth. Surfaces that show an agent — the board,
 * settings, the project form, the agent picker — go through {@link AgentAvatar}
 * rather than importing an asset, so adding a harness is one entry here and
 * nothing else. Agents with no mark fall back to a lettered tile.
 */
const AGENT_LOGOS: Record<string, AgentLogo> = {
	aider: { src: aiderLogo, paint: "colour" },
	amp: { src: ampLogo, paint: "colour" },
	claude: { src: claudeLogo, paint: "colour" },
	"claude-code": { src: claudeCodeLogo, paint: "colour" },
	cline: { src: clineLogo, paint: "mono" },
	codex: { src: codexLogo, paint: "colour" },
	continue: { src: continueLogo, paint: "mono" },
	copilot: { src: copilotLogo, paint: "mono" },
	crush: { src: crushLogo, paint: "colour" },
	cursor: { src: cursorLogo, paint: "mono" },
	devin: { src: devinLogo, paint: "mono" },
	droid: { src: droidLogo, paint: "colour" },
	goose: { src: gooseLogo, paint: "mono" },
	grok: { src: grokLogo, paint: "mono" },
	kilocode: { src: kilocodeLogo, paint: "mono" },
	kimi: { src: kimiLogo, paint: "mono" },
	kiro: { src: kiroLogo, paint: "mono" },
	opencode: { src: opencodeLogo, paint: "mono" },
	pi: { src: piLogo, paint: "mono" },
	qwen: { src: qwenLogo, paint: "colour" },
	vibe: { src: vibeLogo, paint: "colour" },
};

/** The mark for a harness, or undefined when AO ships none for it. */
export function getAgentLogo(provider: string): AgentLogo | undefined {
	return AGENT_LOGOS[provider];
}

/** Harness names that have a mark — handy for tests and icon audits. */
export function agentLogoProviders(): string[] {
	return Object.keys(AGENT_LOGOS);
}
