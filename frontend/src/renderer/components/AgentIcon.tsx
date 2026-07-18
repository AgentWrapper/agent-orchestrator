import type { AgentProvider } from "../types/workspace";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import agyIcon from "../assets/agents/agy.png";
import aiderIcon from "../assets/agents/aider.png";
import ampIcon from "../assets/agents/amp.png";
import auggieIcon from "../assets/agents/auggie.png";
import autohandIcon from "../assets/agents/autohand.png";
import claudeCodeIcon from "../assets/agents/claude-code.png";
import clineIcon from "../assets/agents/cline.png";
import codexIcon from "../assets/agents/codex.png";
import continueIcon from "../assets/agents/continue.png";
import copilotIcon from "../assets/agents/copilot.png";
import crushIcon from "../assets/agents/crush.png";
import cursorIcon from "../assets/agents/cursor.png";
import devinIcon from "../assets/agents/devin.png";
import droidIcon from "../assets/agents/droid.png";
import gooseIcon from "../assets/agents/goose.png";
import grokIcon from "../assets/agents/grok.png";
import kilocodeIcon from "../assets/agents/kilocode.png";
import kimiIcon from "../assets/agents/kimi.png";
import kiroIcon from "../assets/agents/kiro.png";
import opencodeIcon from "../assets/agents/opencode.png";
import piIcon from "../assets/agents/pi.png";
import qwenIcon from "../assets/agents/qwen.png";
import vibeIcon from "../assets/agents/vibe.png";

type AgentIconMeta = {
	src: string;
	label: string;
	imageClassName?: string;
};

const AGENT_ICON_META: Record<AgentProvider, AgentIconMeta> = {
	"claude-code": { src: claudeCodeIcon, label: "Claude Code" },
	codex: { src: codexIcon, label: "Codex" },
	aider: { src: aiderIcon, label: "Aider" },
	opencode: { src: opencodeIcon, label: "OpenCode" },
	grok: { src: grokIcon, label: "Grok Build" },
	droid: { src: droidIcon, label: "Droid" },
	amp: { src: ampIcon, label: "Amp" },
	agy: { src: agyIcon, label: "Agy" },
	crush: { src: crushIcon, label: "Crush" },
	cursor: { src: cursorIcon, label: "Cursor" },
	qwen: { src: qwenIcon, label: "Qwen Code" },
	copilot: { src: copilotIcon, label: "GitHub Copilot", imageClassName: "dark:invert" },
	goose: { src: gooseIcon, label: "Goose" },
	auggie: { src: auggieIcon, label: "Auggie", imageClassName: "dark:invert" },
	continue: { src: continueIcon, label: "Continue" },
	devin: { src: devinIcon, label: "Devin" },
	cline: { src: clineIcon, label: "Cline" },
	kimi: { src: kimiIcon, label: "Kimi" },
	kiro: { src: kiroIcon, label: "Kiro" },
	kilocode: { src: kilocodeIcon, label: "Kilo Code" },
	vibe: { src: vibeIcon, label: "Mistral Vibe" },
	pi: { src: piIcon, label: "Pi" },
	autohand: { src: autohandIcon, label: "Autohand", imageClassName: "dark:invert" },
};

export function AgentIcon({ provider, className }: { provider: AgentProvider; className?: string }) {
	const meta = AGENT_ICON_META[provider];
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					aria-label={meta.label}
					className={cn("grid size-3.5 shrink-0 place-items-center", className)}
					data-agent-provider={provider}
					role="img"
				>
					<img
						alt=""
						aria-hidden="true"
						className={cn("size-full object-contain", meta.imageClassName)}
						draggable={false}
						src={meta.src}
					/>
				</span>
			</TooltipTrigger>
			<TooltipContent side="right">{meta.label}</TooltipContent>
		</Tooltip>
	);
}
