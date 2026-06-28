"use client";

import { useEffect, useState } from "react";

const navItems = [
	{ label: "Features", href: "#features" },
	{ label: "How it works", href: "#how" },
	{ label: "Architecture", href: "#architecture" },
	{ label: "Quickstart", href: "#quickstart" },
];

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

function MenuIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="M4 6h16" />
			<path d="M4 12h16" />
			<path d="M4 18h16" />
		</svg>
	);
}

function XIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="M18 6 6 18" />
			<path d="m6 6 12 12" />
		</svg>
	);
}

function SunIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
		</svg>
	);
}

function MoonIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="M20.99 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 20.99 12.79Z" />
		</svg>
	);
}

export function LandingNav() {
	const [open, setOpen] = useState(false);
	const [theme, setTheme] = useState("dark");
	const [mounted, setMounted] = useState(false);
	const isLight = theme === "light";

	useEffect(() => {
		const current = document.documentElement.dataset.theme;
		setTheme(current === "light" ? "light" : "dark");
		setMounted(true);
	}, []);

	useEffect(() => {
		if (!mounted) return;
		document.documentElement.dataset.theme = theme;
		document.documentElement.classList.toggle("dark", theme === "dark");
		document.documentElement.style.colorScheme = theme;
		window.localStorage.setItem("ao-theme", theme);
	}, [mounted, theme]);

	return (
		<header
			data-testid="site-nav"
			className="sticky top-0 z-40 border-b border-[color:var(--border)] bg-[color:var(--nav-bg)] backdrop-blur-xl"
		>
			<div className="container-page flex h-16 items-center justify-between">
				<a href="#top" data-testid="nav-logo" className="group inline-flex h-10 items-center gap-2.5">
					<img src="/ao-logo.svg" alt="Agent Orchestrator" className="block h-10 w-10 shrink-0 object-contain" />
					<span className="font-display text-[15px] font-bold leading-none tracking-tight text-[color:var(--fg)]">
						Agent Orchestrator
					</span>
				</a>

				<nav className="hidden items-center gap-7 md:flex">
					{navItems.map((item) => (
						<a
							key={item.label}
							href={item.href}
							className="text-[13px] font-medium text-[color:var(--fg-muted)] transition-colors hover:text-[color:var(--fg)]"
						>
							{item.label}
						</a>
					))}
				</nav>

				<div className="flex items-center gap-2">
					<a
						href="https://github.com/AgentWrapper/agent-orchestrator"
						target="_blank"
						rel="noreferrer"
						data-testid="nav-star-btn"
						className="hidden items-center gap-1.5 rounded-md border border-[color:var(--border-strong)] px-2.5 py-1.5 text-[12px] font-medium text-[color:var(--fg-muted)] transition-colors hover:border-[color:var(--border-bright)] hover:text-[color:var(--fg)] sm:inline-flex"
					>
						<GithubIcon className="h-3.5 w-3.5" />
						<span className="font-mono">7.7k</span>
					</a>
					<button
						type="button"
						onClick={() => setTheme(isLight ? "dark" : "light")}
						data-testid="theme-toggle"
						className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[color:var(--border-strong)] text-[color:var(--fg-muted)] transition-colors hover:border-[color:var(--border-bright)] hover:text-[color:var(--fg)]"
						aria-label={isLight ? "Switch to dark theme" : "Switch to light theme"}
						title={isLight ? "Dark theme" : "Light theme"}
					>
						{isLight ? <MoonIcon className="h-4 w-4" /> : <SunIcon className="h-4 w-4" />}
					</button>
					<a
						href="https://github.com/AgentWrapper/agent-orchestrator"
						target="_blank"
						rel="noreferrer"
						data-testid="nav-cta-btn"
						className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--accent)] px-3.5 py-1.5 text-[13px] font-semibold text-white transition-all hover:brightness-110"
						style={{ color: "#fff" }}
					>
						Install
						<ArrowUpRightIcon className="h-3.5 w-3.5" />
					</a>
					<button
						onClick={() => setOpen(!open)}
						className="rounded-md border border-[color:var(--border-strong)] p-1.5 text-[color:var(--fg)] md:hidden"
						data-testid="nav-mobile-toggle"
						aria-label="menu"
					>
						{open ? <XIcon className="h-4 w-4" /> : <MenuIcon className="h-4 w-4" />}
					</button>
				</div>
			</div>
			{open && (
				<div className="border-t border-[color:var(--border)] bg-[color:var(--bg-card)] md:hidden">
					<div className="flex flex-col gap-3.5 px-5 py-4">
						{navItems.map((item) => (
							<a
								key={item.label}
								href={item.href}
								onClick={() => setOpen(false)}
								className="text-sm font-medium text-[color:var(--fg-muted)]"
							>
								{item.label}
							</a>
						))}
					</div>
				</div>
			)}
		</header>
	);
}
