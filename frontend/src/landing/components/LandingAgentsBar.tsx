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
			className="landing-reveal relative overflow-hidden border-y border-[color:var(--border)] bg-[color:var(--bg)]"
		>
			<div className="container-page pt-12 pb-10">
				<div className="mx-auto flex max-w-[1120px] flex-wrap items-baseline justify-between gap-8">
					<div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
						<span className="landing-eyebrow">Coverage</span>
						<h2 className="text-[24px] font-semibold leading-tight text-[color:var(--fg)] sm:text-[32px]">
							One Daemon. <span className="text-[color:var(--fg-muted)]">23 Agent Harnesses.</span>
						</h2>
					</div>
					<p className="max-w-[54ch] text-[14px] leading-[1.6] text-[color:var(--fg-muted)]">
						Swap harnesses per project. The daemon does not care which CLI is in the pane - adapters obey one port.
					</p>
				</div>
			</div>

			<div className="container-page pb-12">
				<div className="relative mx-auto max-w-3xl overflow-hidden">
					<div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-20 bg-gradient-to-r from-[color:var(--bg)] to-transparent" />
					<div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-20 bg-gradient-to-l from-[color:var(--bg)] to-transparent" />
					<div className="agents-marquee-track flex w-max items-end gap-4">
						{marqueeAgents.map((agent, index) => (
							<div
								key={`${agent.id}-${index}`}
								className="group flex h-[82px] w-[112px] shrink-0 flex-col items-center justify-end gap-2 px-2 py-2"
							>
								<div className="agent-logo-tile">
									<img src={agent.src} alt="" referrerPolicy="no-referrer" className="agent-logo-image" />
								</div>
								<div className="max-w-full truncate font-mono text-[12px] leading-none tracking-[0.04em] text-[color:var(--fg-dim)]">
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
