export function LandingVideo() {
	return (
		<section
			id="see-it"
			data-testid="video-section"
			className="relative border-t border-[color:var(--border)] py-24 sm:py-32"
		>
			<div className="container-page">
				<div className="mb-10 text-center">
					<div className="serial-num mb-3 font-mono text-xs opacity-70">see it in action</div>
					<h2
						className="inline-block font-display font-bold leading-[1.02] tracking-tight text-[color:var(--fg)]"
						style={{ fontSize: "clamp(28px, 3.6vw, 44px)" }}
					>
						Watch the founder walk through it -{" "}
						<span className="font-editorial font-medium italic text-[color:var(--accent)]">100 PRs in 6 days.</span>
					</h2>
				</div>

				<div className="relative mx-auto w-full max-w-[1180px]">
					<div className="pointer-events-none absolute -inset-3 rounded-3xl bg-[color:var(--accent)] opacity-[0.045] blur-2xl" />
					<div
						data-testid="video-frame"
						className="glow-accent relative aspect-video overflow-hidden rounded-2xl border border-[color:var(--border-strong)] bg-black"
					>
						<iframe
							src="https://www.youtube-nocookie.com/embed/QdwaeEXOmDs?autoplay=0&rel=0&modestbranding=1&playsinline=1"
							allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
							allowFullScreen
							className="absolute inset-0 h-full w-full border-none"
							title="Agent Orchestrator Launch Demo"
						/>
					</div>
				</div>
			</div>
		</section>
	);
}
