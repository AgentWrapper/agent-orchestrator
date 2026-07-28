import { cn } from "../lib/utils";
import { getAgentLogo } from "../lib/agent-logos";

type AgentAvatarProps = {
	provider: string;
	className?: string;
	/** When true, the logo is purely decorative (label is shown beside it). */
	decorative?: boolean;
};

/**
 * Agent mark for board/task cards, settings and the agent pickers: the harness's
 * real brand logo, with no background plate.
 *
 * The mark and how it has to be painted both come from `lib/agent-logos` — this
 * component only renders. Single-colour marks are drawn as a mask filled with
 * `currentColor` so they follow the theme; marks that carry their own palette
 * are drawn as-is. Harnesses with no mark fall back to a lettered tile.
 *
 * The provider is exposed as the accessible name (alt / aria-label), not just a
 * hover title, so surfaces that show the logo in place of visible agent text —
 * e.g. the archive cards — still name the agent for screen readers.
 */
export function AgentAvatar({ provider, className, decorative = false }: AgentAvatarProps) {
	const logo = getAgentLogo(provider);
	const labelling = decorative
		? { "aria-hidden": true as const }
		: { role: "img", "aria-label": provider, title: provider };

	if (!logo) {
		return (
			<span
				{...labelling}
				className={cn(
					"inline-flex size-icon-base shrink-0 items-center justify-center text-caption font-bold uppercase leading-none text-muted-foreground",
					className,
				)}
			>
				{provider.charAt(0) || "?"}
			</span>
		);
	}

	if (logo.paint === "mono") {
		return (
			<span
				{...labelling}
				className={cn("agent-mark-mono inline-block size-icon-base shrink-0", className)}
				// Quoted: dev asset URLs carry a query string, which an unquoted url()
				// token rejects — the whole declaration is then dropped silently.
				style={{ maskImage: `url("${logo.src}")` }}
			/>
		);
	}

	return (
		<img
			src={logo.src}
			alt={decorative ? "" : provider}
			aria-hidden={decorative || undefined}
			className={cn("size-icon-base shrink-0 object-contain", className)}
			draggable={false}
			title={decorative ? undefined : provider}
		/>
	);
}
