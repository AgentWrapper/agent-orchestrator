import Image from "next/image";

const agents = [
	{ name: "Claude Code", id: "claude-code", src: "/docs/logos/claude-code.svg" },
	{ name: "Codex", id: "codex", src: "/docs/logos/codex.svg" },
	{ name: "Aider", id: "aider", src: "/docs/logos/aider.png" },
	{ name: "OpenCode", id: "opencode", src: "/docs/logos/opencode.svg" },
	{ name: "Grok", id: "grok", src: "https://www.google.com/s2/favicons?domain=x.ai&sz=64" },
	{ name: "Droid", id: "droid", src: "https://www.google.com/s2/favicons?domain=factory.ai&sz=64" },
	{ name: "Amp", id: "amp", src: "https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" },
	{ name: "Agy", id: "agy", src: "https://www.google.com/s2/favicons?domain=antigravity.google&sz=64" },
	{ name: "Crush", id: "crush", src: "https://www.google.com/s2/favicons?domain=charm.land&sz=64" },
	{ name: "Cursor", id: "cursor", src: "/docs/logos/cursor.svg" },
	{ name: "Qwen", id: "qwen", src: "https://www.google.com/s2/favicons?domain=qwenlm.github.io&sz=64" },
	{ name: "Copilot", id: "copilot", src: "https://www.google.com/s2/favicons?domain=github.com&sz=64" },
	{ name: "Goose", id: "goose", src: "https://www.google.com/s2/favicons?domain=goose-docs.ai&sz=64" },
	{ name: "Auggie", id: "auggie", src: "https://www.google.com/s2/favicons?domain=augmentcode.com&sz=64" },
	{ name: "Continue", id: "continue", src: "https://www.google.com/s2/favicons?domain=continue.dev&sz=64" },
	{ name: "Devin", id: "devin", src: "https://www.google.com/s2/favicons?domain=cognition.ai&sz=64" },
	{ name: "Cline", id: "cline", src: "https://www.google.com/s2/favicons?domain=cline.bot&sz=64" },
	{ name: "Kimi", id: "kimi", src: "https://www.google.com/s2/favicons?domain=kimi.com&sz=64" },
	{ name: "Kiro", id: "kiro", src: "https://www.google.com/s2/favicons?domain=kiro.dev&sz=64" },
	{ name: "Kilo Code", id: "kilocode", src: "https://www.google.com/s2/favicons?domain=kilocode.ai&sz=64" },
	{ name: "Vibe", id: "vibe", src: "https://www.google.com/s2/favicons?domain=mistral.ai&sz=64" },
	{ name: "Pi", id: "pi", src: "https://www.google.com/s2/favicons?domain=github.com&sz=64" },
	{ name: "Autohand", id: "autohand", src: "https://www.google.com/s2/favicons?domain=npmjs.com&sz=64" },
];

type Agent = (typeof agents)[number];

function AgentChip({ agent }: { agent: Agent }) {
	return (
		<div className="agent-chip group flex h-12 shrink-0 items-center gap-2.5 pl-3 pr-4">
			<div className="agent-chip-icon">
				<Image
					src={agent.src}
					alt=""
					width={24}
					height={24}
					unoptimized
					referrerPolicy="no-referrer"
					className={`agent-logo-image ${agent.id === "kilocode" ? "agent-logo-image-kilocode" : ""}`}
				/>
			</div>
			<div className="text-[13px] font-medium leading-none text-[color:var(--fg-muted)] transition-colors duration-200 group-hover:text-[color:var(--fg)]">
				{agent.name}
			</div>
		</div>
	);
}

function MarqueeRow({ agents: rowAgents, reverse = false }: { agents: Agent[]; reverse?: boolean }) {
	const doubled = [...rowAgents, ...rowAgents];
	return (
		<div className="relative overflow-hidden">
			<div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24 bg-gradient-to-r from-[color:var(--bg)] to-transparent" />
			<div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-gradient-to-l from-[color:var(--bg)] to-transparent" />
			<div
				className={`flex w-max items-center gap-2.5 ${reverse ? "agents-marquee-track-reverse" : "agents-marquee-track"}`}
			>
				{doubled.map((agent, index) => (
					<AgentChip key={`${agent.id}-${index < rowAgents.length ? "a" : "b"}`} agent={agent} />
				))}
			</div>
		</div>
	);
}

export function LandingAgentsBar() {
	const firstRow = agents.slice(0, 12);
	const secondRow = agents.slice(12);

	return (
		<section
			id="agents"
			data-testid="agents-marquee"
			className="landing-reveal relative overflow-hidden border-y border-white/[0.04] bg-[color:var(--bg)]"
		>
			<div className="container-page pt-14 pb-15">
				<div className="mx-auto max-w-[1180px]">
					<div className="flex flex-wrap items-end justify-between gap-6">
						<div>
							<span className="landing-eyebrow">Coverage</span>
							<h2 className="mt-4 max-w-[720px] text-[28px] font-semibold leading-[1.1] text-[color:var(--fg)] sm:text-[40px]">
								Use the agent you already trust.
								<span className="block text-[color:var(--fg-muted)]">AO keeps the workflow the same.</span>
							</h2>
						</div>
					</div>

					<div className="mt-12 flex flex-col gap-2.5">
						<MarqueeRow agents={firstRow} />
						<MarqueeRow agents={secondRow} reverse />
					</div>

					<div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3 font-mono text-[11px] uppercase text-[color:var(--fg-dim)]">
						<span>23 harnesses</span>
						<span>per-project agent choice</span>
					</div>
				</div>
			</div>
		</section>
	);
}
