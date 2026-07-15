import type { AgentProvider } from "../types/workspace";

const claudeLogo = new URL("../../landing/public/docs/logos/claude.svg", import.meta.url).href;
const codexLogo = new URL("../../landing/public/docs/logos/codex.svg", import.meta.url).href;

export function OrchestratorAvatar({
	provider,
	size = "md",
}: {
	provider?: AgentProvider;
	size?: "sm" | "md" | "lg";
}) {
	const isClaude = provider === "claude-code";
	const knownProvider = isClaude || provider === "codex";
	const providerLabel = isClaude ? "Claude" : provider === "codex" ? "GPT" : "AI";
	const sizeClass = size === "sm" ? "size-8" : size === "lg" ? "size-14" : "size-10";
	const badgeClass = size === "sm" ? "size-3.5 -bottom-0.5 -right-0.5" : "size-5 -bottom-1 -right-1";

	return (
		<div className={`relative shrink-0 ${sizeClass}`} aria-label={`Orbit profile, powered by ${providerLabel}`}>
			<div className="grid size-full place-items-center overflow-hidden rounded-[30%] border border-white/15 bg-[radial-gradient(circle_at_30%_20%,#c7d2fe_0%,#7c3aed_34%,#172554_72%,#09090b_100%)] shadow-[0_8px_24px_rgba(56,40,130,0.35)]">
				<svg aria-hidden="true" className="size-[72%]" viewBox="0 0 48 48">
					<circle cx="24" cy="24" r="6" fill="#f8fafc" />
					<ellipse cx="24" cy="24" rx="17" ry="8" fill="none" stroke="#ddd6fe" strokeWidth="2" />
					<ellipse
						cx="24"
						cy="24"
						rx="17"
						ry="8"
						fill="none"
						stroke="#93c5fd"
						strokeWidth="2"
						transform="rotate(60 24 24)"
					/>
					<circle cx="39" cy="21" r="2.5" fill="#fef08a" />
				</svg>
			</div>
			<span
				className={`absolute grid place-items-center overflow-hidden rounded-full border-2 border-background bg-[#15171b] shadow-sm ${badgeClass}`}
				title={providerLabel}
			>
				{knownProvider ? (
					<img alt={`${providerLabel} logo`} className="size-full object-contain p-[2px]" src={isClaude ? claudeLogo : codexLogo} />
				) : (
					<span className="text-[7px] font-bold text-white">AI</span>
				)}
			</span>
		</div>
	);
}
