"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import gsap from "gsap";
import ScrollTrigger from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { RELEASE_URL } from "../lib/desktop-downloads";
import { useDownloadTarget } from "../lib/use-download-target";
import { useGitHubRepoFacts } from "../lib/use-github-repo-facts";

if (typeof window !== "undefined") {
	gsap.registerPlugin(ScrollTrigger, useGSAP);
}

function MenuIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="M4 6h16" />
			<path d="M4 12h16" />
			<path d="M4 18h16" />
		</svg>
	);
}

function CloseIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="M18 6 6 18" />
			<path d="m6 6 12 12" />
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

function GithubIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.38 7.86 10.9.58.1.79-.25.79-.56v-2.15c-3.2.7-3.88-1.37-3.88-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.56-.29-5.26-1.28-5.26-5.7 0-1.26.45-2.29 1.19-3.1-.12-.3-.52-1.47.11-3.05 0 0 .97-.31 3.18 1.18A10.96 10.96 0 0 1 12 5.99c.98 0 1.97.13 2.9.38 2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.27 5.69.41.36.78 1.07.78 2.16v3.2c0 .31.21.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
		</svg>
	);
}

function DiscordIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M20.32 4.37A19.8 19.8 0 0 0 15.36 2.8a13.7 13.7 0 0 0-.64 1.32 18.4 18.4 0 0 0-5.44 0 13.7 13.7 0 0 0-.64-1.32 19.7 19.7 0 0 0-4.96 1.57C.54 9.04-.32 13.6.1 18.1a19.9 19.9 0 0 0 6.08 3.08c.49-.67.93-1.38 1.3-2.12-.72-.27-1.4-.6-2.05-.98.17-.12.34-.25.5-.38a14.2 14.2 0 0 0 12.14 0c.16.13.33.26.5.38-.65.39-1.34.72-2.06.99.38.74.81 1.45 1.31 2.12a19.9 19.9 0 0 0 6.08-3.08c.5-5.22-.86-9.74-3.58-13.73ZM8.02 15.33c-1.18 0-2.15-1.08-2.15-2.41 0-1.34.95-2.42 2.15-2.42 1.2 0 2.17 1.09 2.15 2.42 0 1.33-.96 2.41-2.15 2.41Zm7.96 0c-1.18 0-2.15-1.08-2.15-2.41 0-1.34.95-2.42 2.15-2.42 1.2 0 2.17 1.09 2.15 2.42 0 1.33-.95 2.41-2.15 2.41Z" />
		</svg>
	);
}

function StarIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M12 2.5l2.95 5.98 6.6.96-4.77 4.65 1.13 6.57L12 17.55l-5.91 3.11 1.13-6.57L2.45 9.44l6.6-.96L12 2.5z" />
		</svg>
	);
}

const socials = [
	{
		label: "Discord",
		href: "https://discord.com/invite/UZv7JjxbwG",
		icon: DiscordIcon,
	},
	{
		label: "X",
		href: "https://twitter.com/aoagents",
		icon: XSocialIcon,
	},
];

const navLinks = [
	{ label: "Demo", href: "#see-it" },
	{ label: "Features", href: "#features" },
	{ label: "Docs", href: "/docs/" },
];

export function LandingNav() {
	const [open, setOpen] = useState(false);
	const navRef = useRef<HTMLDivElement>(null);
	const innerRef = useRef<HTMLDivElement>(null);
	const { stars } = useGitHubRepoFacts();
	const downloadTarget = useDownloadTarget();
	const downloadHref = downloadTarget?.href ?? RELEASE_URL;

	useGSAP(() => {
		// Shrink + hide-on-scroll only on desktop (>=768px). On mobile/tablet the
		// nav stays in its normal, full-size state.
		const mm = gsap.matchMedia();
		mm.add("(min-width: 768px)", () => {
			const trigger = ScrollTrigger.create({
				start: "top -50",
				end: 99999,
				toggleClass: { className: "nav-scrolled", targets: navRef.current },
				onUpdate: (self) => {
					if (self.direction === 1) {
						gsap.to(innerRef.current, {
							yPercent: -100,
							opacity: 0,
							duration: 0.4,
							ease: "power3.inOut",
						});
					} else {
						gsap.to(innerRef.current, {
							yPercent: 0,
							opacity: 1,
							duration: 0.4,
							ease: "power3.out",
						});
					}
				},
			});

			return () => {
				trigger.kill();
				// Clear any inline transform/class left from desktop state.
				navRef.current?.classList.remove("nav-scrolled");
				if (innerRef.current) gsap.set(innerRef.current, { clearProps: "transform,opacity" });
			};
		});
		return () => mm.revert();
	}, []);

	return (
		<header
			data-testid="site-nav"
			ref={navRef}
			className="pointer-events-auto fixed inset-x-0 top-0 z-40 pt-4 px-4 transition-all duration-500 ease-out flex justify-center [&.nav-scrolled]:pt-2"
		>
			<div
				ref={innerRef}
				className="relative mx-auto flex h-14 w-full max-w-4xl items-center justify-between gap-5 rounded-full border border-[color:var(--border)] bg-[color:var(--bg)]/70 px-5 backdrop-blur-xl shadow-lg transition-all duration-500 ease-out [.nav-scrolled_&]:h-12 [.nav-scrolled_&]:max-w-3xl [.nav-scrolled_&]:bg-[color:var(--bg)]/90"
			>
				<Link href="/" data-testid="nav-logo" className="group inline-flex h-10 shrink-0 items-center gap-3">
					<img
						src="/ao-logo.svg"
						alt="Agent Orchestrator"
						className="block h-7 w-7 shrink-0 object-contain transition-transform duration-300 group-hover:scale-105"
					/>
					<span className="text-[14px] font-semibold leading-[1.1] tracking-tight text-[color:var(--fg)] sm:text-[15px]">
						Agent Orchestrator
					</span>
				</Link>

				<nav className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-7 md:flex" aria-label="Primary">
					{navLinks.map((item) =>
						item.href.startsWith("/") ? (
							<Link
								key={item.label}
								href={item.href}
								className="landing-nav-link px-1.5 py-1.5 text-[13px] font-medium tracking-wide focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[color:var(--accent)]"
							>
								{item.label}
							</Link>
						) : (
							<a
								key={item.label}
								href={item.href}
								className="landing-nav-link px-1.5 py-1.5 text-[13px] font-medium tracking-wide focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[color:var(--accent)]"
							>
								{item.label}
							</a>
						),
					)}
				</nav>

				<div className="flex items-center gap-2">
					<a
						href="https://github.com/AgentWrapper/agent-orchestrator"
						target="_blank"
						rel="noreferrer"
						aria-label={`Star Agent Orchestrator on GitHub${stars ? ` — ${stars} stars` : ""}`}
						title="Star on GitHub"
						className="group/starchip inline-flex h-8 items-center gap-1.5 rounded-full border border-[color:var(--border)] bg-[color:var(--bg-elevated)] pl-2.5 pr-3 text-[12px] font-semibold text-[color:var(--fg-muted)] transition-[color,border-color,background-color] duration-300 hover:border-[color:var(--accent-glow)] hover:text-[color:var(--fg)]"
					>
						<GithubIcon className="h-3.5 w-3.5" />
						<StarIcon className="h-3 w-3 text-[color:var(--fg-dim)] transition-colors duration-300 group-hover/starchip:text-[#ffd35c]" />
						{stars ? <span className="font-mono text-[11.5px] leading-none">{stars}</span> : null}
					</a>
					<div className="mx-1 hidden h-4 w-px bg-[color:var(--border)] lg:block [.nav-scrolled_&]:hidden" />
					<div className="hidden items-center gap-3 lg:flex [.nav-scrolled_&]:hidden">
						{socials.map((item) => {
							const Icon = item.icon;
							return (
								<a
									key={item.label}
									href={item.href}
									target="_blank"
									rel="noreferrer"
									aria-label={item.label}
									title={item.label}
									className="group/social inline-flex h-8 w-8 items-center justify-center rounded-full text-[color:var(--fg-dim)] transition-[color,background-color] duration-300 ease-out hover:bg-[color:var(--bg-elevated)] hover:text-[color:var(--fg)]"
								>
									<Icon className="h-4 w-4 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/social:scale-110 group-active/social:scale-90" />
								</a>
							);
						})}
					</div>
					<a
						href={downloadHref}
						className="hero-pressable btn-primary hidden h-9 items-center gap-1.5 rounded-full px-4 text-[13px] font-semibold md:inline-flex"
					>
						Download
					</a>
					<button
						type="button"
						aria-label={open ? "Close navigation menu" : "Open navigation menu"}
						aria-expanded={open}
						aria-controls="mobile-navigation-menu"
						className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[color:var(--fg)] transition-colors hover:bg-[color:var(--bg-elevated)] md:hidden"
						onClick={() => setOpen(!open)}
					>
						{open ? <CloseIcon className="h-5 w-5" /> : <MenuIcon className="h-5 w-5" />}
					</button>
				</div>
			</div>

			{open && (
				<div
					id="mobile-navigation-menu"
					className="absolute inset-x-0 top-full mt-4 flex flex-col gap-1 rounded-2xl border border-[color:var(--border)] bg-[color:var(--bg)]/95 p-4 mx-4 backdrop-blur-xl shadow-2xl md:hidden"
				>
					{navLinks.map((item) =>
						item.href.startsWith("/") ? (
							<Link
								key={item.label}
								href={item.href}
								onClick={() => setOpen(false)}
								className="flex items-center rounded-lg px-4 py-3 text-[15px] font-medium text-[color:var(--fg)] transition-colors hover:bg-[color:var(--bg-elevated)]"
							>
								{item.label}
							</Link>
						) : (
							<a
								key={item.label}
								href={item.href}
								onClick={() => setOpen(false)}
								className="flex items-center rounded-lg px-4 py-3 text-[15px] font-medium text-[color:var(--fg)] transition-colors hover:bg-[color:var(--bg-elevated)]"
							>
								{item.label}
							</a>
						),
					)}
					<div className="my-2 h-px bg-[color:var(--border)]" />
					<div className="flex justify-center gap-6 py-2">
						<a
							href="https://github.com/AgentWrapper/agent-orchestrator"
							target="_blank"
							rel="noreferrer"
							aria-label="GitHub"
							title="GitHub"
							className="inline-flex items-center gap-1.5 text-[color:var(--fg-muted)] hover:text-[color:var(--fg)]"
						>
							<GithubIcon className="h-5 w-5" />
							<span className="font-mono text-[12px]">{stars ?? ""}</span>
						</a>
						{socials.map((item) => {
							const Icon = item.icon;
							return (
								<a
									key={item.label}
									href={item.href}
									target="_blank"
									rel="noreferrer"
									aria-label={item.label}
									title={item.label}
									className="text-[color:var(--fg-muted)] hover:text-[color:var(--fg)]"
								>
									<Icon className="h-5 w-5" />
								</a>
							);
						})}
					</div>
				</div>
			)}
		</header>
	);
}
