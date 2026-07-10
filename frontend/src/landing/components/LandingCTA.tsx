import { formatCompactNumber, getGitHubRepoStats } from "../lib/github-repo";

function GithubIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.38 7.86 10.9.58.1.79-.25.79-.56v-2.15c-3.2.7-3.88-1.37-3.88-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.56-.29-5.26-1.28-5.26-5.7 0-1.26.45-2.29 1.19-3.1-.12-.3-.52-1.47.11-3.05 0 0 .97-.31 3.18 1.18A10.96 10.96 0 0 1 12 5.99c.98 0 1.97.13 2.9.38 2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.27 5.69.41.36.78 1.07.78 2.16v3.2c0 .31.21.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
		</svg>
	);
}

function ArrowRightIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="M5 12h14" />
			<path d="m12 5 7 7-7 7" />
		</svg>
	);
}

function BookIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="M12 7v14" />
			<path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
		</svg>
	);
}

export async function LandingCTA() {
	const { stars } = await getGitHubRepoStats();

	return (
		<section
			id="cta"
			data-testid="cta-section"
			className="relative overflow-hidden border-t border-[color:var(--border)] py-24 sm:py-32"
		>
			<div className="container-page relative">
				<div className="surface-elev px-8 py-14 text-center sm:px-14 sm:py-20">
					<div className="mb-8 inline-flex items-center gap-2 rounded-full border border-[color:var(--border-strong)] bg-[color:var(--bg-deep)] px-3 py-1">
						<span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--accent)]">
							$ ao spawn --project your-repo --prompt &quot;ship it&quot;
						</span>
					</div>

					<h2
						data-testid="cta-headline"
						className="font-display font-bold leading-[1.02] tracking-tight text-[color:var(--fg)]"
						style={{ fontSize: "clamp(36px, 6vw, 76px)" }}
					>
						Stop babysitting one agent.
						<br />
						<span className="font-editorial font-medium italic text-[color:var(--accent)]">Start orchestrating.</span>
					</h2>

					<p className="mx-auto mt-6 max-w-2xl text-[16px] leading-relaxed text-[color:var(--fg-muted)] sm:text-[17px]">
						Free, Apache 2.0 licensed, runs on your laptop. The whole repo is on GitHub - read the source, fork it, and
						ship your first parallel agent in five minutes.
					</p>

					<div className="mt-10 flex flex-wrap items-center justify-center gap-3">
						<a
							href="https://github.com/AgentWrapper/agent-orchestrator"
							target="_blank"
							rel="noreferrer"
							data-testid="cta-github-btn"
							className="group inline-flex items-center gap-2 rounded-lg bg-[color:var(--accent)] px-6 py-3.5 text-[15px] font-semibold shadow-[0_0_0_1px_rgba(255,255,255,0.1)_inset,0_8px_24px_-8px_rgba(130,170,255,0.42)] transition-all hover:brightness-110"
							style={{ color: "#081225" }}
						>
							<GithubIcon className="h-4 w-4" />
							Star on GitHub · {formatCompactNumber(stars)}
							<ArrowRightIcon className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
						</a>
						<a
							href="/docs/architecture"
							data-testid="cta-docs-btn"
							className="inline-flex items-center gap-2 rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--bg-deep)] px-6 py-3.5 text-[15px] font-semibold text-[color:var(--fg)] transition-colors hover:bg-[color:var(--bg-card-hover)]"
						>
							<BookIcon className="h-4 w-4" />
							Read the architecture
						</a>
					</div>
				</div>
			</div>
		</section>
	);
}
