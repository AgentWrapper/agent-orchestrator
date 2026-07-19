"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import gsap from "gsap";
import ScrollTrigger from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";

if (typeof window !== "undefined") {
	gsap.registerPlugin(ScrollTrigger, useGSAP);
}

type Post = {
	handle: string;
	statusIdParts: string[];
	author: string;
	verified?: boolean;
	text: string;
	date: string;
	likes?: number;
};

const posts: Post[] = [
	{
		handle: "Teknium",
		statusIdParts: ["204231", "894145", "7170790"],
		author: "Teknium",
		verified: true,
		text: "It can orchestrate agents but this looks a bit more advanced.",
		date: "Apr 10, 2026",
		likes: 4,
	},
	{
		handle: "facito0",
		statusIdParts: ["203638", "079647", "5547760"],
		author: "FacitoO",
		text: "Me with @aoagents lately!",
		date: "May 2, 2026",
	},
	{
		handle: "buchireddy",
		statusIdParts: ["206410", "814460", "7760628"],
		author: "Buchi Reddy B",
		verified: true,
		text: "I really loved the building blocks present in @aoagents, hence we went all-in on that pretty early. Happy to share more details if it helps others.",
		date: "Jun 9, 2026",
		likes: 3,
	},
	{
		handle: "oxwizzdom",
		statusIdParts: ["204349", "124837", "6336484"],
		author: "oxwizzdom",
		verified: true,
		text: "1/ @agent_wrapper & @composio shipped @aoagents a while back. runs 50 coding agents in parallel on the same repo. i spent a weekend reading the codebase. found 5 techniques that make it work.",
		date: "Apr 14, 2026",
	},
	{
		handle: "addddiiie",
		statusIdParts: ["203717", "443270", "0211408"],
		author: "Adi",
		text: "I just hired a few software devs to work for free cc - @aoagents",
		date: "Mar 26, 2026",
		likes: 9,
	},
];

function postUrl(post: Post) {
	return `https://twitter.com/${post.handle}/status/${post.statusIdParts.join("")}`;
}

function ArrowUpRightIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="M7 7h10v10" />
			<path d="M7 17 17 7" />
		</svg>
	);
}

function XSocialIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M18.9 2.25h3.24l-7.08 8.09 8.33 11.41h-6.52l-5.11-6.91-5.84 6.91H2.66l7.57-8.67L2.25 2.25h6.69l4.62 6.3 5.34-6.3Zm-1.14 17.5h1.8L7.96 4.14H6.03l11.73 15.61Z" />
		</svg>
	);
}

function VerifiedIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34Zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77Z" />
		</svg>
	);
}

export function LandingSocialProof() {
	const containerRef = useRef<HTMLElement>(null);

	useGSAP(
		() => {
			const cards = gsap.utils.toArray<HTMLElement>(".gsap-tweet-card");

			// Reduced motion: show everything immediately, no entrance animation.
			if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
				gsap.set(cards, { opacity: 1, y: 0 });
				return;
			}

			gsap.set(cards, { opacity: 0, y: 30 });

			// Reveal each card as it enters the viewport. On mobile the masonry is a
			// single tall column, so a single section-top trigger left the lower cards
			// invisible until far past the heading; batching reveals them in step with
			// the scroll on every layout.
			const batch = ScrollTrigger.batch(cards, {
				start: "top 90%",
				once: true,
				onEnter: (els: Element[]) => {
					gsap.to(els, {
						opacity: 1,
						y: 0,
						duration: 0.7,
						stagger: 0.08,
						ease: "power3.out",
					});
				},
			});

			ScrollTrigger.refresh();

			return () => batch.forEach((t) => t.kill());
		},
		{ scope: containerRef },
	);

	return (
		<section
			ref={containerRef}
			id="testimonials"
			data-testid="social-proof"
			className="relative overflow-hidden border-t border-[color:var(--border)] pt-16 pb-8 sm:pt-[clamp(80px,9vw,120px)] sm:pb-[clamp(80px,9vw,120px)]"
		>
			<div className="container-page">
				<div className="mx-auto max-w-[1320px]">
					<div className="mb-8 grid items-end gap-8 sm:mb-[clamp(64px,8vw,100px)] lg:grid-cols-12">
						<div className="lg:col-span-7">
							<div className="landing-eyebrow mb-4">In the wild</div>
							<h2 className="landing-heading">
								People are already <span className="landing-heading-muted">building around it.</span>
							</h2>
						</div>
						<div className="lg:col-span-5">
							<p className="landing-body-compact pb-0 sm:pb-17">
								Real posts from builders, researchers, and early users - pulled straight from X.
							</p>
						</div>
					</div>

					<div className="tweet-masonry">
						{posts.map((post, index) => (
							<TweetCard key={post.handle} post={post} index={index} />
						))}
					</div>
				</div>
			</div>
		</section>
	);
}

function Avatar({ post }: { post: Post }) {
	const [failed, setFailed] = useState(false);

	if (failed) {
		return (
			<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[color:var(--accent-soft)] text-sm font-bold text-[color:var(--accent)]">
				{post.author.slice(0, 1)}
			</div>
		);
	}

	return (
		<Image
			src={`https://unavatar.io/x/${post.handle}`}
			alt={`${post.author} avatar`}
			width={40}
			height={40}
			unoptimized
			referrerPolicy="no-referrer"
			onError={() => setFailed(true)}
			className="h-10 w-10 shrink-0 rounded-full border border-[color:var(--border)] object-cover"
		/>
	);
}

function TweetCard({ post, index }: { post: Post; index: number }) {
	const url = postUrl(post);

	return (
		<a
			href={url}
			target="_blank"
			rel="noreferrer"
			data-testid={`tweet-card-${index}`}
			aria-label={`Read ${post.author}'s post on X`}
			className="gsap-tweet-card lift surface group mb-8 inline-block w-full break-inside-avoid overflow-hidden p-5"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 items-center gap-3">
					<Avatar post={post} />
					<div className="min-w-0">
						<div className="flex items-center gap-1">
							<span className="truncate text-[14px] font-semibold leading-tight text-[color:var(--fg)]">
								{post.author}
							</span>
							{post.verified ? <VerifiedIcon className="h-3.5 w-3.5 shrink-0 text-[color:var(--accent)]" /> : null}
						</div>
						<span className="truncate text-[12px] leading-tight text-[color:var(--fg-dim)]">@{post.handle}</span>
					</div>
				</div>
				<XSocialIcon className="h-4 w-4 shrink-0 text-[color:var(--fg-muted)]" />
			</div>

			<p className="mt-4 whitespace-pre-line text-[15px] leading-relaxed text-[color:var(--fg)]">{post.text}</p>

			<div className="mt-4 flex items-center justify-between border-t border-[color:var(--border)] pt-3">
				<span className="text-[12px] text-[color:var(--fg-dim)]">{post.date}</span>
				<span className="inline-flex items-center gap-3 text-[12px] text-[color:var(--fg-dim)]">
					{typeof post.likes === "number" ? (
						<span className="inline-flex items-center gap-1">
							<svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
								<path d="M12 21s-7.5-4.6-10-9.3C.4 8.4 2 5 5.2 5c1.9 0 3.2 1 3.8 2.2H11C11.6 6 12.9 5 14.8 5 18 5 19.6 8.4 22 11.7 19.5 16.4 12 21 12 21Z" />
							</svg>
							{post.likes}
						</span>
					) : null}
					<span className="inline-flex items-center gap-1 font-medium text-[color:var(--fg-muted)] transition-colors group-hover:text-[color:var(--accent)]">
						View on X
						<ArrowUpRightIcon className="h-3 w-3" />
					</span>
				</span>
			</div>
		</a>
	);
}
