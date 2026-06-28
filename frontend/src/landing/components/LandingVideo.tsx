export function LandingVideo() {
	return (
		<section
			id="see-it"
			data-testid="video-section"
			className="relative border-t border-[color:var(--border)] py-24 sm:py-32"
		>
			<div className="container-page">
				<div className="mx-auto mb-10 max-w-[1180px] text-left">
					<h2 className="inline-block font-mono text-[13px] font-bold uppercase leading-none tracking-[0.18em] text-[color:var(--fg-muted)]">
						See it in action
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
