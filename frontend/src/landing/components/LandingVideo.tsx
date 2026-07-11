"use client";

import { useState } from "react";

export function LandingVideo() {
	const muxPlaybackId = process.env.NEXT_PUBLIC_MUX_PLAYBACK_ID ?? "sqEsVHcr01aPubYnAy6Z00pCrjuKmLMkkCgXvDxon84ao";
	const [isPlaying, setIsPlaying] = useState(false);
	const videoTitle = "Agent Orchestrator Launch Demo";
	const encodedTitle = encodeURIComponent(videoTitle);
	const previewPosterUrl = "/mux-video-preview.jpg";

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
						{muxPlaybackId && isPlaying ? (
							<iframe
								src={`https://player.mux.com/${muxPlaybackId}?metadata-video-title=${encodedTitle}&video-title=${encodedTitle}&autoplay=1`}
								allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
								allowFullScreen
								className="absolute inset-0 h-full w-full border-none"
								title={videoTitle}
							/>
						) : muxPlaybackId ? (
							<button
								type="button"
								onClick={() => setIsPlaying(true)}
								className="group absolute inset-0 cursor-pointer overflow-hidden text-left"
								aria-label={`Play ${videoTitle}`}
							>
								<img
									src={previewPosterUrl}
									alt=""
									className="absolute inset-0 h-full w-full object-cover opacity-80 transition duration-500 group-hover:scale-[1.015] group-hover:opacity-95"
								/>
								<div className="absolute inset-0 bg-gradient-to-t from-black via-black/55 to-black/20" />
								<div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-6 p-6 sm:p-8">
									<div>
										<div className="max-w-[680px] text-2xl font-semibold tracking-[-0.04em] text-[color:var(--fg)] sm:text-4xl">
											{videoTitle}
										</div>
									</div>
									<span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-white/20 bg-white text-black shadow-2xl transition duration-200 group-hover:scale-105">
										<span className="ml-1 h-0 w-0 border-y-[9px] border-l-[14px] border-y-transparent border-l-black" />
									</span>
								</div>
							</button>
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
