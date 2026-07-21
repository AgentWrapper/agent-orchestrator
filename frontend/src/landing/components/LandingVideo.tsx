"use client";

import Image from "next/image";
import { useState } from "react";

function PlayIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M8 5.5v13a1 1 0 0 0 1.53.85l10.2-6.5a1 1 0 0 0 0-1.7L9.53 4.65A1 1 0 0 0 8 5.5Z" />
		</svg>
	);
}

export function LandingVideo() {
	const muxPlaybackId = process.env.NEXT_PUBLIC_MUX_PLAYBACK_ID ?? "cpmHxjRygocH1rPeKq6jk4UYxGghl8B8ABcop4Gc01b8";
	const videoTitle = "AO Demo";
	const encodedTitle = encodeURIComponent(videoTitle);
	const [playing, setPlaying] = useState(false);

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
					<p className="landing-body-compact mt-5 max-w-[560px]">
						100 PRs in 6 days — watch AO run a fleet of agents end to end, from task to merged PR.
					</p>
				</div>

				<div className="relative mx-auto w-full max-w-[1180px]">
					<div className="pointer-events-none absolute -inset-3 rounded-lg bg-[color:var(--accent)] opacity-[0.025] blur-2xl" />
					<div
						data-testid="video-frame"
						className="relative aspect-video overflow-hidden rounded-md border border-[color:var(--border-strong)] bg-black"
					>
						{playing ? (
							<iframe
								src={`https://player.mux.com/${muxPlaybackId}?autoplay=true&metadata-video-title=${encodedTitle}&video-title=${encodedTitle}`}
								allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture"
								allowFullScreen
								className="absolute inset-0 h-full w-full border-none"
								title={videoTitle}
							/>
						) : (
							<button
								type="button"
								onClick={() => setPlaying(true)}
								aria-label={`Play video: ${videoTitle}`}
								className="group absolute inset-0 h-full w-full cursor-pointer"
							>
								<Image
									src="/mux-video-preview.jpg"
									alt="Still from the Agent Orchestrator demo video: 100 PRs in 6 days"
									fill
									sizes="(min-width: 1280px) 1180px, 100vw"
									className="object-cover transition-transform duration-700 ease-out group-hover:scale-[1.02]"
								/>
								<span className="absolute inset-0 bg-black/25 transition-colors duration-300 group-hover:bg-black/15" />
								<span className="absolute inset-0 grid place-items-center">
									<span className="grid h-16 w-16 place-items-center rounded-full border border-white/25 bg-black/55 text-white shadow-2xl backdrop-blur-md transition-all duration-300 group-hover:scale-105 group-hover:bg-[color:var(--accent)] group-hover:text-[#11140c] sm:h-20 sm:w-20">
										<PlayIcon className="h-6 w-6 translate-x-[2px] sm:h-7 sm:w-7" />
									</span>
								</span>
								<span className="absolute bottom-4 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/55 px-3 py-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-white/85 backdrop-blur-sm">
									Watch the demo
								</span>
							</button>
						)}
					</div>
				</div>
			</div>
		</section>
	);
}
