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

export function LandingAgentsBar() {
	const marqueeAgents = [...agents, ...agents];

	return (
		<section
			id="agents"
			data-testid="agents-marquee"
			className="relative overflow-hidden border-y border-[color:var(--border)] bg-[color:var(--bg-deep)]"
		>
			<div className="container-page py-7">
				<div className="mx-auto flex max-w-[1280px] flex-wrap items-baseline justify-between gap-5">
					<div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
						<span className="serial-num font-mono text-xs">Coverage</span>
						<h2 className="font-display text-2xl font-bold leading-none tracking-tight text-[color:var(--fg)] sm:text-3xl">
							One Daemon. <span className="text-[color:var(--fg-muted)]">23 agent harnesses.</span>
						</h2>
					</div>
					<p className="max-w-md font-mono text-xs leading-relaxed text-[color:var(--fg-dim)]">
						Swap harnesses per project. The daemon does not care which CLI is in the pane - adapters obey one port.
					</p>
				</div>
			</div>

			<div className="container-page pb-6">
				<div className="relative mx-auto max-w-3xl overflow-hidden">
					<div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-20 bg-gradient-to-r from-[color:var(--bg-deep)] to-transparent" />
					<div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-20 bg-gradient-to-l from-[color:var(--bg-deep)] to-transparent" />
					<div className="agents-marquee-track flex w-max items-end gap-3">
						{marqueeAgents.map((agent, index) => (
							<div
								key={`${agent.id}-${index}`}
								className="group flex h-[78px] w-[118px] shrink-0 flex-col items-center justify-end gap-2 px-2 py-2"
							>
								<div className="flex h-10 items-end justify-center">
									<img
										src={agent.src}
										alt=""
										referrerPolicy="no-referrer"
										className="h-8 max-w-[44px] object-contain transition-transform duration-200 ease-out group-hover:scale-110"
									/>
								</div>
								<div className="max-w-full truncate font-mono text-[14px] leading-none tracking-[0.04em] text-[color:var(--fg-dim)]">
									{agent.name}
								</div>
							</div>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}
