"use client";

import { useEffect, useState } from "react";

function ArrowUpRightIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="M7 7h10v10" />
			<path d="M7 17 17 7" />
		</svg>
	);
}

function DownloadIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="M12 3v12" />
			<path d="m7 10 5 5 5-5" />
			<path d="M5 21h14" />
		</svg>
	);
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

function DiscordIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M20.32 4.37A19.8 19.8 0 0 0 15.36 2.8a13.7 13.7 0 0 0-.64 1.32 18.4 18.4 0 0 0-5.44 0 13.7 13.7 0 0 0-.64-1.32 19.7 19.7 0 0 0-4.96 1.57C.54 9.04-.32 13.6.1 18.1a19.9 19.9 0 0 0 6.08 3.08c.49-.67.93-1.38 1.3-2.12-.72-.27-1.4-.6-2.05-.98.17-.12.34-.25.5-.38a14.2 14.2 0 0 0 12.14 0c.16.13.33.26.5.38-.65.39-1.34.72-2.06.99.38.74.81 1.45 1.31 2.12a19.9 19.9 0 0 0 6.08-3.08c.5-5.22-.86-9.74-3.58-13.73ZM8.02 15.33c-1.18 0-2.15-1.08-2.15-2.41 0-1.34.95-2.42 2.15-2.42 1.2 0 2.17 1.09 2.15 2.42 0 1.33-.96 2.41-2.15 2.41Zm7.96 0c-1.18 0-2.15-1.08-2.15-2.41 0-1.34.95-2.42 2.15-2.42 1.2 0 2.17 1.09 2.15 2.42 0 1.33-.95 2.41-2.15 2.41Z" />
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
	{ label: "Docs", href: "/docs" },
];

function getPlatformLabel() {
	if (typeof navigator === "undefined") return "Install AO";

	const platform = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
	if (platform.includes("mac")) return "Install for macOS";
	if (platform.includes("win")) return "Install for Windows";
	if (platform.includes("linux") || platform.includes("x11")) return "Install for Linux";
	return "Install AO";
}

export function LandingNav() {
	const [open, setOpen] = useState(false);
	const [installLabel, setInstallLabel] = useState("Install AO");

	useEffect(() => {
		setInstallLabel(getPlatformLabel());
	}, []);

	useEffect(() => {
		document.documentElement.dataset.theme = "dark";
		document.documentElement.classList.add("dark");
		document.documentElement.style.colorScheme = "dark";
	}, []);

	return (
		<header data-testid="site-nav" className="pointer-events-none fixed inset-x-0 top-4 z-40 flex justify-center px-4">
			<div className="pointer-events-auto grid h-14 w-full max-w-[1040px] grid-cols-[1fr_auto] items-center gap-4 rounded-2xl bg-black/[0.58] px-4 shadow-[0_20px_70px_-52px_rgba(0,0,0,1),inset_0_1px_0_rgba(255,255,255,0.08),inset_0_0_0_1px_rgba(255,255,255,0.055)] backdrop-blur-2xl sm:px-5 md:grid-cols-[1fr_auto_1fr]">
				<a
					href="#top"
					data-testid="nav-logo"
					className="group inline-flex h-10 shrink-0 items-center gap-3 justify-self-start"
				>
					<img
						src="/ao-logo.svg"
						alt="Agent Orchestrator"
						className="block h-9 w-9 shrink-0 -translate-y-1 object-contain"
					/>
					<span className="font-display text-[15px] font-bold leading-[1.1] tracking-tight text-[color:var(--fg)]">
						Agent Orchestrator
					</span>
				</a>

				<nav
					className="hidden items-center justify-center gap-1 rounded-xl bg-white/[0.035] p-1 justify-self-center md:flex"
					aria-label="Primary"
				>
					{navLinks.map((item) => (
						<a
							key={item.label}
							href={item.href}
							className="rounded-lg px-4 py-2 text-[14px] font-semibold text-[color:var(--fg-muted)] transition-[background-color,color,transform] duration-160 ease-out hover:bg-white/[0.08] hover:text-[color:var(--fg)] active:scale-95"
						>
							{item.label}
						</a>
					))}
				</nav>

				<div className="hidden items-center justify-end gap-2 justify-self-end md:flex">
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
								className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-white/[0.035] text-[color:var(--fg-muted)] transition-[background-color,color,transform,filter] duration-160 ease-out hover:scale-105 hover:bg-white/[0.075] hover:text-[color:var(--fg)] active:scale-95"
							>
								<Icon className="h-5 w-5" />
							</a>
						);
					})}
					<a
						href="/docs/installation"
						data-testid="nav-cta-btn"
						className="group ml-1 inline-flex h-9 items-center gap-2 rounded-md bg-[color:var(--accent)] px-4 text-[13px] font-semibold shadow-[0_0_0_1px_rgba(255,255,255,0.08)_inset] transition-all hover:brightness-110"
						style={{ color: "#081225" }}
					>
						<DownloadIcon className="h-4 w-4" />
						<span>{installLabel}</span>
						<ArrowUpRightIcon className="h-3.5 w-3.5 opacity-80 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
					</a>
				</div>

				<div className="flex items-center gap-2 md:hidden">
					<a
						href="/docs/installation"
						data-testid="nav-mobile-cta-btn"
						className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[color:var(--accent)] px-3 text-[12px] font-semibold"
						style={{ color: "#081225" }}
					>
						<DownloadIcon className="h-3.5 w-3.5" />
						Install
					</a>
					<button
						onClick={() => setOpen(!open)}
						className="rounded-md border border-[color:var(--border-strong)] p-2 text-[color:var(--fg)]"
						data-testid="nav-mobile-toggle"
						aria-label="menu"
					>
						{open ? <CloseIcon className="h-4 w-4" /> : <MenuIcon className="h-4 w-4" />}
					</button>
				</div>
			</div>
			{open && (
				<div className="pointer-events-auto mt-2 w-[calc(100%-2rem)] max-w-[980px] rounded-2xl bg-black/[0.72] p-3 shadow-[0_20px_70px_-52px_rgba(0,0,0,1),inset_0_1px_0_rgba(255,255,255,0.08),inset_0_0_0_1px_rgba(255,255,255,0.055)] backdrop-blur-2xl md:hidden">
					<div className="flex flex-col gap-3">
						{socials.map((item) => {
							const Icon = item.icon;
							return (
								<a
									key={item.label}
									href={item.href}
									target="_blank"
									rel="noreferrer"
									onClick={() => setOpen(false)}
									className="inline-flex items-center gap-2 rounded-md border border-[color:var(--border)] px-3 py-2 text-sm font-medium text-[color:var(--fg-muted)]"
								>
									<Icon className="h-4 w-4" />
									{item.label}
								</a>
							);
						})}
						<a
							href="/docs/installation"
							onClick={() => setOpen(false)}
							className="inline-flex items-center justify-center gap-2 rounded-md bg-[color:var(--accent)] px-3 py-2.5 text-sm font-semibold"
							style={{ color: "#081225" }}
						>
							<DownloadIcon className="h-4 w-4" />
							{installLabel}
						</a>
					</div>
				</div>
			)}
		</header>
	);
}
