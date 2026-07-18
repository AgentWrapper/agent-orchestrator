"use client";

export function LandingVideo() {
	const muxPlaybackId = process.env.NEXT_PUBLIC_MUX_PLAYBACK_ID ?? "zWxz3vxZBxGtXUwjP4lG7Krql7WN8PaOrs6MRmfpSKc";
	const videoTitle = "Agent Orchestrator Launch Demo";
	const encodedTitle = encodeURIComponent(videoTitle);

	return (
		<section
			id="see-it"
			data-testid="video-section"
			className="landing-reveal relative border-t border-white/[0.04] pt-16 pb-8 sm:pt-[clamp(56px,7vw,96px)] sm:pb-[clamp(48px,6vw,72px)]"
		>
			<div className="container-page">
				<div className="landing-section-header mx-auto max-w-[1180px] text-left">
					<div className="landing-eyebrow mb-4">Demo</div>
					<h2 className="landing-heading">See it in action</h2>
				</div>

				<div className="relative mx-auto w-full max-w-[1180px]">
					<div className="pointer-events-none absolute -inset-3 rounded-lg bg-[color:var(--accent)] opacity-[0.025] blur-2xl" />
					<div
						data-testid="video-frame"
						className="relative aspect-video overflow-hidden rounded-md border border-[color:var(--border-strong)] bg-black"
					>
						{muxPlaybackId ? (
							<iframe
								src={`https://player.mux.com/${muxPlaybackId}?metadata-video-title=${encodedTitle}&video-title=${encodedTitle}`}
								allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture"
								allowFullScreen
								className="absolute inset-0 h-full w-full border-none"
								title={videoTitle}
							/>
						) : (
							<div className="absolute inset-0 flex items-center justify-center px-6 text-center">
								<div>
									<div className="font-mono text-[12px] uppercase tracking-[0.18em] text-[color:var(--fg-dim)]">
										Mux demo video
									</div>
									<div className="mt-3 text-xl font-semibold tracking-[-0.03em] text-[color:var(--fg)]">
										Add a Mux playback ID to publish this demo.
									</div>
								</div>
							</div>
						)}
					</div>
				</div>
			</div>
		</section>
	);
}
