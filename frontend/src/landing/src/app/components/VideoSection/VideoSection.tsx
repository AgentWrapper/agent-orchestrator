"use client";

import Image from "next/image";
import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { track } from "@/lib/analytics";
import { newVideoProgressState, reportVideoProgress } from "@/lib/analytics/video-progress";

// Loaded on demand, not with the page. The player is ~1.1MB and the section is
// below the fold behind a click, so a static import put it on the critical path
// of every homepage visit for a video most visitors never play. It is only
// rendered once `playing` is true, so there is nothing to show until then.
const MuxPlayer = dynamic(() => import("@mux/mux-player-react"), { ssr: false });

const MUX_PLAYBACK_ID =
	process.env.NEXT_PUBLIC_MUX_PLAYBACK_ID ??
	"cpmHxjRygocH1rPeKq6jk4UYxGghl8B8ABcop4Gc01b8";
const VIDEO_TITLE = "AO Demo";

function PlayIcon({ className = "" }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M8 5.5v13a1 1 0 0 0 1.53.85l10.2-6.5a1 1 0 0 0 0-1.7L9.53 4.65A1 1 0 0 0 8 5.5Z" />
		</svg>
	);
}

export function VideoSection() {
	const [playing, setPlaying] = useState(false);
	// One view's reported milestones. Lives in a ref so a re-render never resets
	// it and re-reports a milestone the visitor already passed.
	// Lazy ref init: passing newVideoProgressState() as the useRef argument would
	// build a fresh Set on every render and immediately discard it. Build it once,
	// on first render, and read the stable value out for the rest of the render.
	const progressRef = useRef<ReturnType<typeof newVideoProgressState> | null>(null);
	progressRef.current ??= newVideoProgressState();
	const progress = progressRef.current;

	return (
		<section id="see-it" className="relative px-4 py-16 sm:px-8 sm:py-20 lg:px-[30px] lg:py-24">
			<div className="mx-auto max-w-7xl">
				<div className="max-w-3xl text-left select-none">
					<h2 className="text-2xl sm:text-3xl lg:text-4xl font-semibold text-foreground">
						See it in action
					</h2>
					<p className="mt-3 text-base text-muted-foreground">
						Watch AO run a fleet of agents end to end on a single repo, from task to merged PR.
					</p>
				</div>

				<div className="relative mx-auto mt-12 w-full">
					<div
						data-testid="video-frame"
						className="relative aspect-video overflow-hidden bg-black"
					>
						{playing ? (
							// An in-page player rather than the player.mux.com iframe this
							// replaced: playback position is not readable across that origin, so
							// watch-through could not be measured at all through the embed.
							<MuxPlayer
								playbackId={MUX_PLAYBACK_ID}
								autoPlay
								metadata={{ video_title: VIDEO_TITLE }}
								title={VIDEO_TITLE}
								className="absolute inset-0 h-full w-full"
								onTimeUpdate={(event) => {
									const player = event.currentTarget as { currentTime?: number; duration?: number };
									reportVideoProgress(progress, player.currentTime ?? 0, player.duration ?? 0);
								}}
								onEnded={() => {
									// currentTime rarely lands exactly on duration, so without this the
									// 100% milestone would be missed by the people who watched it all.
									reportVideoProgress(progress, 1, 1);
								}}
							/>
						) : (
							<button
								type="button"
								onClick={() => {
									// Only the start. Watch time lives inside the Mux iframe and is not
									// readable from this page, so a duration here would be invented.
									track("video_started", { video: "demo", placement: "see_it" });
									setPlaying(true);
								}}
								aria-label={`Play video: ${VIDEO_TITLE}`}
								className="group absolute inset-0 cursor-pointer"
							>
								<Image
									src="/mux-video-preview.jpg"
									alt="Still from the Agent Orchestrator demo video"
									fill
									sizes="(min-width: 1280px) 1280px, 100vw"
									className="object-cover"
								/>
								<span className="absolute inset-0 grid place-items-center">
									<PlayIcon className="h-14 w-14 translate-x-[3px] text-white transition-transform duration-200 group-hover:scale-110 sm:h-16 sm:w-16" />
								</span>
							</button>
						)}
					</div>
				</div>
			</div>
		</section>
	);
}
