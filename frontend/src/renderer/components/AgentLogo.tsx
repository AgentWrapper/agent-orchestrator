import type { AgentProvider } from "../types/workspace";
import { cn } from "../lib/utils";

import aiderLogo from "../../landing/public/docs/logos/aider.png";
import claudeLogo from "../../landing/public/docs/logos/claude.svg";
import codexLogo from "../../landing/public/docs/logos/codex.svg";
import continueLogo from "../../landing/public/docs/logos/continue.png";
import copilotLogo from "../../landing/public/docs/logos/copilot.png";
import crushLogo from "../../landing/public/docs/logos/crush.png";
import cursorLogo from "../../landing/public/docs/logos/cursor.svg";
import devinLogo from "../../landing/public/docs/logos/devin.png";
import droidLogo from "../../landing/public/docs/logos/droid.png";
import gooseLogo from "../../landing/public/docs/logos/goose.png";
import grokLogo from "../../landing/public/docs/logos/grok.png";
import kilocodeLogo from "../../landing/public/docs/logos/kilocode.png";
import kimiLogo from "../../landing/public/docs/logos/kimi.png";
import kiroLogo from "../../landing/public/docs/logos/kiro.png";
import opencodeLogo from "../../landing/public/docs/logos/opencode.svg";
import piLogo from "../../landing/public/docs/logos/pi.png";
import qwenLogo from "../../landing/public/docs/logos/qwen.png";
import vibeLogo from "../../landing/public/docs/logos/vibe.png";

const AGENT_LOGOS: Partial<Record<AgentProvider, string>> = {
	aider: aiderLogo,
	"claude-code": claudeLogo,
	codex: codexLogo,
	continue: continueLogo,
	copilot: copilotLogo,
	crush: crushLogo,
	cursor: cursorLogo,
	devin: devinLogo,
	droid: droidLogo,
	goose: gooseLogo,
	grok: grokLogo,
	kilocode: kilocodeLogo,
	kimi: kimiLogo,
	kiro: kiroLogo,
	opencode: opencodeLogo,
	pi: piLogo,
	qwen: qwenLogo,
	vibe: vibeLogo,
};

type AgentLogoProps = {
	provider: AgentProvider;
	className?: string;
};

/** Brand mark for an agent harness; falls back to a monogram when no asset exists. */
export function AgentLogo({ provider, className }: AgentLogoProps) {
	const src = AGENT_LOGOS[provider];
	if (src) {
		return <img alt="" aria-hidden="true" className={cn("object-contain", className)} src={src} />;
	}
	const initial = provider.charAt(0).toUpperCase();
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-flex items-center justify-center rounded-sm bg-interactive-active font-mono text-2xs font-bold leading-none text-foreground",
				className,
			)}
		>
			{initial}
		</span>
	);
}
