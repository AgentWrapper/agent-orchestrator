"use client";

import { useEffect, useRef, useState } from "react";

declare global {
	interface Window {
		twttr?: {
			ready?: (callback: () => void) => void;
			widgets?: {
				load?: (element?: HTMLElement) => void;
				createTweet?: (
					tweetId: string,
					element: HTMLElement,
					options?: { theme?: "dark" | "light"; dnt?: boolean; conversation?: "none"; width?: number },
				) => Promise<HTMLElement>;
			};
		};
	}
}

const posts = [
	{
		handle: "Teknium",
		statusIdParts: ["204231", "894145", "7170790"],
		label: "Signal",
		author: "Teknium",
		note: "Most important outside validation.",
		text: "Outside validation that AO is landing with serious agent builders.",
		meta: "builder signal",
	},
	{
		handle: "facito0",
		statusIdParts: ["203638", "079647", "5547760"],
		label: "Mood",
		author: "FacitoO",
		note: "A lightweight social proof hit from daily AO usage.",
		text: "A small but useful signal from someone actually using the workflow.",
		meta: "daily AO usage",
	},
	{
		handle: "buchireddy",
		statusIdParts: ["206410", "814460", "7760628"],
		label: "Builder",
		author: "Buchi Reddy B",
		note: "Went all-in early on the AO building blocks.",
		text: "I really loved the building blocks present in @aoagents, hence we went all-in on that pretty early. Happy to share more details if it helps others.",
		meta: "3:41 AM - Jun 9, 2026",
	},
	{
		handle: "oxwizzdom",
		statusIdParts: ["204349", "124837", "6336484"],
		label: "Code read",
		author: "oxwizzdom",
		note: "Weekend codebase teardown and minimal rebuild.",
		text: "1/ @agent_wrapper & @composio shipped @aoagents a while back. runs 50 coding agents in parallel on the same repo. i spent a weekend reading the codebase. found 5 techniques that make it work.",
		meta: "repo teardown",
	},
	{
		handle: "addddiiie",
		statusIdParts: ["203717", "443270", "0211408"],
		label: "Use case",
		author: "Adi",
		note: "Parallel dev agents framed in one clean line.",
		text: "The core use case explained simply: parallel agents without babysitting.",
		meta: "parallel workflow",
	},
	{
		handle: "aoagents",
		statusIdParts: ["205420", "723754", "8302804"],
		label: "Official",
		author: "Agent Orchestrator",
		note: "A short official signal from the AO account.",
		text: "Best as it gets",
		meta: "official AO",
	},
];

function postUrl(post: (typeof posts)[number]) {
	return `https://twitter.com/${post.handle}/status/${post.statusIdParts.join("")}`;
}

function postId(post: (typeof posts)[number]) {
	return post.statusIdParts.join("");
}

function ArrowUpRightIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="M7 7h10v10" />
			<path d="M7 17 17 7" />
		</svg>
	);
}

function MessageCircleIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
		</svg>
	);
}

function loadTwitterWidgets(target?: HTMLElement | null, onReady?: () => void) {
	const load = () => {
		window.twttr?.widgets?.load?.(target ?? undefined);
		window.twttr?.ready?.(() => onReady?.());
		onReady?.();
	};

	if (window.twttr?.widgets) {
		load();
		return;
	}

	const existing = document.getElementById("twitter-wjs");
	if (existing) {
		existing.addEventListener("load", load, { once: true });
		return;
	}

	const script = document.createElement("script");
	script.id = "twitter-wjs";
	script.src = "https://platform.twitter.com/widgets.js";
	script.async = true;
	script.charset = "utf-8";
	script.onload = load;
	document.body.appendChild(script);
}

function usePageTheme() {
	const [theme, setTheme] = useState("dark");

	useEffect(() => {
		setTheme(document.documentElement.dataset.theme || "dark");
		const observer = new MutationObserver(() => {
			setTheme(document.documentElement.dataset.theme || "dark");
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});
		return () => observer.disconnect();
	}, []);

	return theme;
}

export function LandingSocialProof() {
	const theme = usePageTheme();
	const tweetRefs = useRef<Record<string, HTMLDivElement | null>>({});

	useEffect(() => {
		const target = document.getElementById("testimonials");
		const renderTweets = () => {
			for (const post of posts) {
				const id = postId(post);
				const node = tweetRefs.current[id];
				if (!node || node.dataset.tweetRendered === `${id}-${theme}`) continue;
				if (!window.twttr?.widgets?.createTweet) continue;

				node.dataset.tweetRendered = `${id}-${theme}`;
				node.innerHTML = "";
				void window.twttr.widgets
					.createTweet(id, node, {
						theme: theme === "light" ? "light" : "dark",
						dnt: true,
						conversation: "none",
						width: 420,
					})
					.catch(() => {
						delete node.dataset.tweetRendered;
					});
			}
		};

	loadTwitterWidgets(target, renderTweets);
	window.twttr?.ready?.(renderTweets);

	const timers = [350, 1000, 2200, 4200, 7000].map((delay) =>
		window.setTimeout(() => {
			window.twttr?.ready?.(renderTweets);
			renderTweets();
			}, delay),
		);

		return () => timers.forEach((timer) => window.clearTimeout(timer));
	}, [theme]);

	return (
		<section
			id="testimonials"
			data-testid="social-proof"
			className="relative overflow-hidden border-t border-[color:var(--border)] py-24 sm:py-32"
		>
			<div className="container-page">
				<div className="mx-auto max-w-[1320px]">
					<div className="mb-12 grid items-end gap-8 lg:grid-cols-12">
						<div className="lg:col-span-7">
							<div className="serial-num mb-3 font-mono text-xs">In the wild</div>
							<h2
								className="font-display font-bold leading-[1.02] tracking-tight text-[color:var(--fg)]"
								style={{ fontSize: "clamp(32px, 4.8vw, 60px)" }}
							>
								People are already{" "}
								<span className="font-editorial font-medium italic text-[color:var(--accent)]">
									building around it.
								</span>
							</h2>
						</div>
						<div className="lg:col-span-5">
							<p className="text-[15px] leading-relaxed text-[color:var(--fg-muted)]">
								Real posts from builders, researchers, and early users, embedded directly from X.
							</p>
						</div>
					</div>

					<div className="tweet-masonry">
						{posts.map((post, index) => (
							<TweetCard
								key={`${theme}-${post.handle}-${index}`}
								post={post}
								index={index}
								setTweetRef={(node) => {
									tweetRefs.current[postId(post)] = node;
								}}
							/>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}

function TweetFallback({ post, url }: { post: (typeof posts)[number]; url: string }) {
	return (
		<div className="tweet-fallback">
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 items-center gap-3">
					<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[color:var(--accent-soft)] text-sm font-bold text-[color:var(--accent)]">
						{post.author.slice(0, 1)}
					</div>
					<div className="min-w-0">
						<div className="truncate text-[15px] font-semibold text-[color:var(--fg)]">{post.author}</div>
						<div className="truncate text-[13px] text-[color:var(--fg-dim)]">@{post.handle}</div>
					</div>
				</div>
				<span className="text-lg font-semibold text-[color:var(--fg-muted)]">X</span>
			</div>

			<p className="mt-4 whitespace-pre-line text-[17px] leading-relaxed text-[color:var(--fg)]">{post.text}</p>

			<div className="mt-5 border-t border-[color:var(--border-strong)] pt-3 text-[13px] text-[color:var(--fg-dim)]">
				{post.meta}
			</div>
			<div className="mt-4 flex items-center gap-5 text-[13px] text-[color:var(--fg-muted)]">
				<span>Like</span>
				<span>Reply</span>
				<a href={url} target="_blank" rel="noreferrer" className="hover:text-[color:var(--accent)]">
					Read more on X
				</a>
			</div>
		</div>
	);
}

function TweetCard({
	post,
	index,
	setTweetRef,
}: {
	post: (typeof posts)[number];
	index: number;
	setTweetRef: (node: HTMLDivElement | null) => void;
}) {
	const url = postUrl(post);

	return (
		<article
			data-testid={`tweet-card-${index}`}
			className="surface mb-5 inline-block w-full break-inside-avoid overflow-hidden transition duration-300 hover:-translate-y-0.5 hover:border-[color:var(--accent-soft)]"
		>
			<div className="flex items-center justify-between gap-3 border-b border-[color:var(--border)] bg-[color:var(--bg-chrome)] px-4 py-3">
				<div className="flex min-w-0 items-center gap-2">
					<MessageCircleIcon className="h-4 w-4 shrink-0 text-[color:var(--accent)]" />
					<div className="min-w-0">
						<div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[color:var(--fg-dim)]">
							{post.label}
						</div>
						<div className="truncate text-[13px] font-semibold text-[color:var(--fg)]">{post.author}</div>
					</div>
				</div>
				<a
					href={url}
					target="_blank"
					rel="noreferrer"
					aria-label={`Open ${post.author} post`}
					className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[color:var(--border-strong)] text-[color:var(--fg-muted)] transition-colors hover:text-[color:var(--accent)]"
				>
					<ArrowUpRightIcon className="h-4 w-4" />
				</a>
			</div>

			<div className="px-3 pb-4 pt-3">
				<p className="mb-3 px-1 text-[13px] leading-relaxed text-[color:var(--fg-muted)]">{post.note}</p>
				<div className="tweet-shell [&_.twitter-tweet]:mx-auto [&_.twitter-tweet]:max-w-full">
					<div
						ref={setTweetRef}
						className="min-h-[240px]"
					>
						<TweetFallback post={post} url={url} />
					</div>
				</div>
			</div>
		</article>
	);
}
