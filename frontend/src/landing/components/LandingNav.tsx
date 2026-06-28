"use client";

import { useEffect, useState } from "react";

function GithubIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.38 7.86 10.9.58.1.79-.25.79-.56v-2.15c-3.2.7-3.88-1.37-3.88-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.56-.29-5.26-1.28-5.26-5.7 0-1.26.45-2.29 1.19-3.1-.12-.3-.52-1.47.11-3.05 0 0 .97-.31 3.18 1.18A10.96 10.96 0 0 1 12 5.99c.98 0 1.97.13 2.9.38 2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.27 5.69.41.36.78 1.07.78 2.16v3.2c0 .31.21.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
		</svg>
	);
}

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

const socials = [
	{
		label: "GitHub",
		href: "https://github.com/AgentWrapper/agent-orchestrator",
		icon: GithubIcon,
	},
	{
		label: "X",
		href: "https://twitter.com/aoagents",
		icon: XSocialIcon,
	},
];

const navLinks = [
	{ label: "Demo", href: "#see-it" },
	{ label: "Agents", href: "#agents" },
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
