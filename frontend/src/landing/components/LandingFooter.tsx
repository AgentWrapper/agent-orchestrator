const LOGO_URL = "/ao-logo.svg";

function GithubIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.38 7.86 10.9.58.1.79-.25.79-.56v-2.15c-3.2.7-3.88-1.37-3.88-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.56-.29-5.26-1.28-5.26-5.7 0-1.26.45-2.29 1.19-3.1-.12-.3-.52-1.47.11-3.05 0 0 .97-.31 3.18 1.18A10.96 10.96 0 0 1 12 5.99c.98 0 1.97.13 2.9.38 2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.27 5.69.41.36.78 1.07.78 2.16v3.2c0 .31.21.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
		</svg>
	);
}

const productLinks = [
	{ label: "Features", href: "#features" },
	{ label: "How it works", href: "#how" },
	{ label: "Architecture", href: "#architecture" },
	{ label: "Quickstart", href: "#quickstart" },
];

const resourceLinks = [
	{ label: "GitHub", href: "https://github.com/AgentWrapper/agent-orchestrator" },
	{ label: "Architecture docs", href: "/docs/architecture" },
	{ label: "CLI reference", href: "/docs/cli" },
	{ label: "Releases", href: "https://github.com/AgentWrapper/agent-orchestrator/releases" },
];

const communityLinks = [
	{ label: "Contributors", href: "https://github.com/AgentWrapper/agent-orchestrator/graphs/contributors" },
	{ label: "Issues", href: "https://github.com/AgentWrapper/agent-orchestrator/issues" },
	{ label: "Pull requests", href: "https://github.com/AgentWrapper/agent-orchestrator/pulls" },
	{ label: "ao-agents.com", href: "https://ao-agents.com" },
];

export function LandingFooter() {
	return (
		<footer data-testid="footer" className="border-t border-[color:var(--border)] bg-[color:var(--bg-deep)]">
			<div className="container-page py-16">
				<div className="grid gap-10 md:grid-cols-12">
					<div className="md:col-span-5">
						<div className="mb-4 inline-flex h-10 items-center gap-2.5">
							<img src={LOGO_URL} alt="Agent Orchestrator" className="block h-10 w-10 shrink-0 object-contain" />
							<span className="font-display text-lg font-bold leading-none tracking-tight text-[color:var(--fg)]">
								Agent Orchestrator
							</span>
						</div>
						<p className="max-w-sm text-[14px] leading-relaxed text-[color:var(--fg-muted)]">
							The open-source orchestration layer for parallel AI coding agents. Loopback-only, Apache 2.0 licensed,
							runs on your laptop.
						</p>
					</div>

					<FooterCol title="Product" links={productLinks} />
					<FooterCol title="Resources" links={resourceLinks} />
					<FooterCol title="Community" links={communityLinks} />
				</div>

				<div className="mt-14 flex flex-col items-start justify-between gap-3 border-t border-[color:var(--border)] pt-6 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--fg-dim)] sm:flex-row sm:items-center">
					<div>Built by the open-source community.</div>
					<a
						href="https://github.com/AgentWrapper/agent-orchestrator"
						target="_blank"
						rel="noreferrer"
						className="inline-flex items-center gap-1.5 transition-colors hover:text-[color:var(--accent)]"
						data-testid="footer-github-link"
					>
						<GithubIcon className="h-3 w-3" />
						AgentWrapper/agent-orchestrator
					</a>
				</div>
			</div>
		</footer>
	);
}

function FooterCol({ title, links }: { title: string; links: Array<{ label: string; href: string }> }) {
	return (
		<div className="md:col-span-2 lg:col-span-2">
			<h4 className="mb-4 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--fg-dim)]">{title}</h4>
			<ul className="space-y-2.5">
				{links.map((link) => (
					<li key={link.label}>
						<a
							href={link.href}
							target={link.href.startsWith("#") || link.href.startsWith("/") ? undefined : "_blank"}
							rel={link.href.startsWith("#") || link.href.startsWith("/") ? undefined : "noreferrer"}
							className="text-[13.5px] text-[color:var(--fg-muted)] transition-colors hover:text-[color:var(--fg)]"
						>
							{link.label}
						</a>
					</li>
				))}
			</ul>
		</div>
	);
}
