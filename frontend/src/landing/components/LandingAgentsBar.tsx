const agents = [
	{ name: "Claude Code", src: "/docs/logos/claude-code.svg", alt: "Claude Code", className: "h-7 sm:h-8 lg:h-10" },
	{ name: "Codex", src: "/docs/logos/codex.svg", alt: "Codex", className: "h-7 sm:h-8 lg:h-10 rounded-md" },
	{ name: "Cursor", src: "/docs/logos/cursor.svg", alt: "Cursor", className: "agent-logo-contrast h-7 sm:h-8 lg:h-10" },
	{ name: "Aider", src: "/docs/logos/aider.png", alt: "Aider", className: "h-6 sm:h-7 lg:h-8" },
	{
		name: "OpenCode",
		src: "/docs/logos/opencode.svg",
		alt: "OpenCode",
		className: "agent-logo-contrast h-7 sm:h-8 lg:h-10",
	},
];

export function LandingAgentsBar() {
	return (
		<section
			id="agents"
			data-testid="agents-marquee"
			className="relative overflow-hidden border-y border-[color:var(--border)] bg-[color:var(--bg-deep)]"
		>
			<div className="container-page py-7">
				<div className="mx-auto flex max-w-[1280px] flex-wrap items-baseline justify-between gap-5">
					<div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
						<span className="serial-num font-mono text-xs">01 - coverage</span>
						<h2 className="font-display text-2xl font-bold leading-none tracking-tight text-[color:var(--fg)] sm:text-3xl">
							One daemon. <span className="text-[color:var(--fg-muted)]">Twenty-three agent harnesses.</span>
						</h2>
					</div>
					<p className="max-w-md font-mono text-xs leading-relaxed text-[color:var(--fg-dim)]">
						Swap harnesses per project. The daemon does not care which CLI is in the pane - adapters obey one port.
					</p>
				</div>
			</div>

			<div className="container-page pb-6">
				<div className="mx-auto grid max-w-2xl grid-cols-2 items-end justify-items-center gap-x-0 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
					{agents.map((agent) => (
						<div key={agent.name} className="group flex min-h-[60px] w-full flex-col items-center justify-end gap-2">
							<div className="flex h-9 items-end justify-center sm:h-10 lg:h-11">
								<img
									src={agent.src}
									alt={agent.alt}
									className={`${agent.className} max-w-[56px] object-contain transition-transform duration-300 group-hover:-translate-y-0.5`}
								/>
							</div>
							<div className="font-mono text-[14px] leading-none tracking-[0.06em] text-[color:var(--fg-dim)] sm:text-[16px] lg:text-[18px]">
								{agent.name}
							</div>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}
