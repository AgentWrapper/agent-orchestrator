import Image from "next/image";
import Link from "next/link";

// NOT IN USE
const LOGO_URL = "/ao-logo-transparent.png";

const columns = [
	{
		title: "Product",
		links: [
			{ label: "Features", href: "#features" },
			{ label: "Agents", href: "#agents" },
			{ label: "Install", href: "/docs/installation/" },
			{ label: "CLI", href: "/docs/cli/" },
			{ label: "Design partners", href: "/design-partners/" },
		],
	},
	{
		title: "Docs",
		links: [
			{ label: "Overview", href: "/docs/" },
			{ label: "Architecture", href: "/docs/architecture/" },
			{ label: "Plugins", href: "/docs/plugins/" },
			{ label: "Changelog", href: "/docs/changelog/" },
		],
	},
	{
		title: "Community",
		links: [
			{ label: "GitHub", href: "https://github.com/AgentWrapper/agent-orchestrator" },
			{ label: "Discord", href: "https://discord.com/invite/UZv7JjxbwG" },
			{ label: "X", href: "https://x.com/aoagents" },
			{ label: "Releases", href: "https://github.com/AgentWrapper/agent-orchestrator/releases" },
		],
	},
];

function GithubIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.38 7.86 10.9.58.1.79-.25.79-.56v-2.15c-3.2.7-3.88-1.37-3.88-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.56-.29-5.26-1.28-5.26-5.7 0-1.26.45-2.29 1.19-3.1-.12-.3-.52-1.47.11-3.05 0 0 .97-.31 3.18 1.18A10.96 10.96 0 0 1 12 5.99c.98 0 1.97.13 2.9.38 2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.27 5.69.41.36.78 1.07.78 2.16v3.2c0 .31.21.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
		</svg>
	);
}

export function LandingFooter() {
	return (
		<footer data-testid="footer" className="landing-reveal border-t border-[color:var(--border)] bg-[color:var(--bg)]">
			<div className="container-page py-12 sm:py-24">
				<div className="grid gap-10 lg:grid-cols-[0.95fr_1.05fr]">
					<div className="max-w-md">
						<Link href="/" className="inline-flex items-center gap-3">
							<Image
								src={LOGO_URL}
								alt="Agent Orchestrator"
								width={40}
								height={40}
								className="h-10 w-10 object-contain"
							/>
							<span className="text-[16px] font-semibold text-[color:var(--fg)]">Agent Orchestrator</span>
						</Link>
						<p className="mt-4 max-w-md text-[14px] leading-relaxed text-[color:var(--fg-muted)]">
							Open-source orchestration for terminal-native coding agents. Local daemon, isolated worktrees, live
							sessions, and PR feedback routed to the right worker.
						</p>
						<div className="mt-5 flex flex-wrap gap-2">
							<a
								href="https://github.com/AgentWrapper/agent-orchestrator"
								target="_blank"
								rel="noreferrer"
								className="fluid-press group/ghf inline-flex items-center gap-2 rounded-sm border border-[color:var(--border)] bg-white/[0.025] px-3 py-2 text-[13px] font-medium text-[color:var(--fg-muted)] hover:border-[color:var(--accent-glow)] hover:bg-[color:var(--bg-card-hover)] hover:text-[color:var(--fg)]"
							>
								<GithubIcon className="h-4 w-4 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/ghf:scale-110" />
								GitHub
							</a>
							<span className="inline-flex items-center rounded-sm border border-[color:var(--border)] bg-white/[0.015] px-3 py-2 font-mono text-[12px] text-[color:var(--fg-dim)]">
								Apache 2.0
							</span>
						</div>
					</div>

					<div className="grid gap-8 sm:grid-cols-3 lg:justify-items-end">
						{columns.map((column) => (
							<div key={column.title} className="w-full max-w-[160px]">
								<h4 className="mb-4 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--fg-dim)]">
									{column.title}
								</h4>
								<ul className="space-y-2.5">
									{column.links.map((link) => (
										<li key={link.label}>
											<a
												href={link.href}
												target={link.href.startsWith("#") || link.href.startsWith("/") ? undefined : "_blank"}
												rel={link.href.startsWith("#") || link.href.startsWith("/") ? undefined : "noreferrer"}
												className="group/footlink relative inline-block text-[13px] text-[color:var(--fg-muted)] transition-colors duration-200 hover:text-[color:var(--fg)]"
											>
												{link.label}
												<span className="absolute -bottom-0.5 left-0 h-px w-full origin-left scale-x-0 bg-[color:var(--accent)] transition-transform duration-300 ease-out group-hover/footlink:scale-x-100" />
											</a>
										</li>
									))}
								</ul>
							</div>
						))}
					</div>
				</div>

				<div className="mt-20 flex flex-col justify-between gap-3 border-t border-[color:var(--border)] pt-5 font-mono text-[10px] uppercase tracking-[0.2em] text-[color:var(--fg-dim)] sm:flex-row">
					<a
						href="https://github.com/AgentWrapper/agent-orchestrator"
						target="_blank"
						rel="noreferrer"
						className="transition-colors duration-200 hover:text-[color:var(--fg)]"
					>
						AgentWrapper/agent-orchestrator
					</a>
					<span>Runs locally on your laptop.</span>
				</div>
			</div>
		</footer>
	);
}
