import { cn } from "../lib/utils";
import aiderLogo from "../assets/agents/aider.png";
import ampLogo from "../assets/agents/amp.svg";
import clineLogo from "../assets/agents/cline.svg";
import claudeLogo from "../assets/agents/claude.svg";
import claudeCodeLogo from "../assets/agents/claude-code.svg";
import codexLogo from "../assets/agents/codex.svg";
import continueLogo from "../assets/agents/continue.png";
import copilotLogo from "../assets/agents/copilot.png";
import crushLogo from "../assets/agents/crush.png";
import cursorLogo from "../assets/agents/cursor.svg";
import devinLogo from "../assets/agents/devin.png";
import droidLogo from "../assets/agents/droid.png";
import gooseLogo from "../assets/agents/goose.png";
import grokLogo from "../assets/agents/grok.png";
import kilocodeLogo from "../assets/agents/kilocode.png";
import kimiLogo from "../assets/agents/kimi.png";
import kiroLogo from "../assets/agents/kiro.png";
import opencodeLogo from "../assets/agents/opencode.svg";
import piLogo from "../assets/agents/pi.png";
import qwenLogo from "../assets/agents/qwen.png";
import vibeLogo from "../assets/agents/vibe.png";

// Real brand logos keyed by the harness name AO stores on session.provider.
// Agents without an asset fall back to a lettered tile (agy, auggie, autohand,
// fake).
const LOGOS: Record<string, string> = {
	codex: codexLogo,
	"claude-code": claudeCodeLogo,
	claude: claudeLogo,
	cursor: cursorLogo,
	opencode: opencodeLogo,
	copilot: copilotLogo,
	aider: aiderLogo,
	grok: grokLogo,
	droid: droidLogo,
	crush: crushLogo,
	qwen: qwenLogo,
	goose: gooseLogo,
	continue: continueLogo,
	devin: devinLogo,
	kimi: kimiLogo,
	kiro: kiroLogo,
	kilocode: kilocodeLogo,
	vibe: vibeLogo,
	pi: piLogo,
	amp: ampLogo,
	cline: clineLogo,
};

type AgentAvatarProps = {
	provider: string;
	className?: string;
};

/**
 * Agent mark for board/task cards: the harness's real brand logo rendered bare —
 * no tile, border, or background — so each brand's own shape shows (codex,
 * claude, cursor, … carry their own rounded backgrounds). Agents without an
 * asset fall back to a bare initial. Kept small so the title stays the hero.
 */
export function AgentAvatar({ provider, className }: AgentAvatarProps) {
	const logo = LOGOS[provider];
	if (logo) {
		return (
			<img
				src={logo}
				alt=""
				className={cn("size-icon-xl shrink-0 object-contain", className)}
				draggable={false}
				title={provider}
			/>
		);
	}
	return (
		<span
			className={cn(
				"inline-flex size-icon-xl shrink-0 items-center justify-center text-caption font-bold uppercase leading-none text-muted-foreground",
				className,
			)}
			title={provider}
		>
			{provider.charAt(0) || "?"}
		</span>
	);
}
