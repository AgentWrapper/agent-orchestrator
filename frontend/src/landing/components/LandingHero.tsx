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

export function LandingHero() {
	return (
		<section
			data-testid="hero-section"
			id="top"
			className="relative overflow-hidden border-b border-[color:var(--border)] pb-20 pt-14 sm:pt-16 lg:pb-24"
		>
			<div
				className="pointer-events-none absolute inset-0 opacity-[0.24]"
				style={{
					backgroundImage:
						"linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
					backgroundSize: "44px 44px",
					maskImage: "radial-gradient(ellipse at 52% 42%, black 0%, transparent 68%)",
					WebkitMaskImage: "radial-gradient(ellipse at 52% 42%, black 0%, transparent 68%)",
				}}
			/>
			<div className="relative z-10 mx-auto w-full max-w-[1680px] px-5 sm:px-8 lg:px-12 xl:px-16">
				<div className="grid items-center gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-10 xl:gap-14">
					<div className="max-w-[760px] text-left">
						<div className="mb-5 font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-[color:var(--accent)]">
							Agent work, from issue to merge
						</div>
						<h1
							data-testid="hero-headline"
							className="font-display font-bold leading-[0.94] tracking-tight text-[color:var(--fg)]"
							style={{ fontSize: "clamp(52px, 5.05vw, 96px)" }}
						>
							<span className="block 2xl:whitespace-nowrap">Review the work,</span>
							<span className="block text-[color:var(--accent)] 2xl:whitespace-nowrap">Not the agents.</span>
						</h1>
						<p
							data-testid="hero-subtitle"
							className="mt-6 max-w-[720px] text-[18px] font-semibold leading-[1.62] text-[color:var(--fg-muted)] sm:text-[20px]"
						>
							Every issue gets its own checkout, session, branch, PR, checks, and review thread. When something breaks,
							the right context goes back to the right agent.
						</p>
						<div className="mt-8 flex flex-wrap items-center gap-3">
							<a
								href="https://github.com/AgentWrapper/agent-orchestrator"
								target="_blank"
								rel="noreferrer"
								data-testid="hero-primary-cta"
								className="group inline-flex items-center gap-2 rounded-lg bg-[color:var(--accent)] px-5 py-3 text-[14px] font-semibold text-white shadow-[0_0_0_1px_rgba(255,255,255,0.1)_inset] transition-all hover:brightness-110"
								style={{ color: "#fff" }}
							>
								<GithubIcon className="h-4 w-4" />
								Install Agent Orchestrator
								<ArrowRightIcon className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
							</a>
							<a
								href="/docs"
								data-testid="hero-secondary-cta"
								className="inline-flex items-center gap-2 rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--bg-card)] px-5 py-3 text-[14px] font-semibold text-[color:var(--fg)] transition-colors hover:bg-[color:var(--bg-card-hover)]"
							>
								<BookIcon className="h-4 w-4" />
								Read the docs
							</a>
						</div>
						<div className="mt-8 border-l border-[color:var(--border-strong)] pl-4 font-mono text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-dim)]">
							issue -&gt; worktree -&gt; session -&gt; pull request -&gt; review loop
						</div>
					</div>

					<div className="relative min-w-0 overflow-visible lg:pl-2" data-testid="hero-screenshot">
						<div className="relative ml-auto w-full max-w-[1080px] pr-[clamp(70px,8vw,150px)] sm:pr-[clamp(95px,10vw,180px)] lg:pr-[clamp(110px,8vw,190px)]">
							<div className="relative rounded-[18px] border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-1">
								<div className="overflow-hidden rounded-[13px] bg-[color:var(--bg-deep)]">
									<img
										src="/hero-dashboard.png"
										alt="Agent Orchestrator dashboard board view"
										className="theme-dark-only block w-full"
										draggable="false"
									/>
									<img
										src="/hero-dashboard-light.png"
										alt="Agent Orchestrator dashboard board view in light theme"
										className="theme-light-only hidden w-full"
										draggable="false"
									/>
								</div>
							</div>
							<div className="absolute bottom-0 right-0 hidden w-[26%] min-w-[170px] translate-y-[12%] sm:block">
								<div className="rounded-[24px] border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-1 shadow-[0_24px_80px_-48px_rgba(0,0,0,0.95)]">
									<div className="relative overflow-hidden rounded-[19px] bg-[color:var(--bg-deep)]">
										<img
											src="/hero-new-task.png"
											alt="Agent Orchestrator mobile workflow preview"
											className="theme-dark-only block aspect-[9/16] h-auto w-full object-cover object-center"
											draggable="false"
										/>
										<img
											src="/hero-dashboard-light.png"
											alt="Agent Orchestrator mobile workflow preview in light theme"
											className="theme-light-only hidden aspect-[9/16] h-auto w-full object-cover object-center"
											draggable="false"
										/>
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
