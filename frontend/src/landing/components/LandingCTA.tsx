"use client";

import { useGitHubRepoFacts } from "../lib/use-github-repo-facts";
import { useDownloadTarget, useIsMacDesktop } from "../lib/use-download-target";
import { CopyCommand } from "./CopyCommand";

const BREW_INSTALL_COMMAND = "brew install --cask agentwrapper/tap/agent-orchestrator";

function GithubIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.38 7.86 10.9.58.1.79-.25.79-.56v-2.15c-3.2.7-3.88-1.37-3.88-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.56-.29-5.26-1.28-5.26-5.7 0-1.26.45-2.29 1.19-3.1-.12-.3-.52-1.47.11-3.05 0 0 .97-.31 3.18 1.18A10.96 10.96 0 0 1 12 5.99c.98 0 1.97.13 2.9.38 2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.27 5.69.41.36.78 1.07.78 2.16v3.2c0 .31.21.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
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

function StarIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M12 2.5l2.95 5.98 6.6.96-4.77 4.65 1.13 6.57L12 17.55l-5.91 3.11 1.13-6.57L2.45 9.44l6.6-.96L12 2.5z" />
		</svg>
	);
}

export function LandingCTA() {
	const { stars } = useGitHubRepoFacts();
	const downloadTarget = useDownloadTarget();
	const showBrew = useIsMacDesktop();

	return (
		<section
			id="get-started"
			data-testid="cta-section"
			className="landing-reveal relative overflow-hidden border-t border-[color:var(--border)] py-20 sm:py-28"
		>
			{/* soft accent glow */}
			<div
				className="pointer-events-none absolute inset-0"
				style={{
					background: "radial-gradient(ellipse 60% 55% at 50% 62%, var(--accent-soft), transparent 70%)",
				}}
			/>
			<div className="container-page relative">
				<div className="mx-auto max-w-[860px] text-center">
					<div className="landing-eyebrow mb-5">Get started</div>
					<h2
						data-testid="cta-headline"
						className="landing-hero-heading mx-auto"
						style={{ fontSize: "clamp(34px, 4.6vw, 64px)" }}
					>
						<span className="landing-hero-heading-setup block">Your agents are waiting.</span>
						<span className="landing-hero-heading-action block">
							Put them to <span className="landing-hero-heading-accent">work.</span>
						</span>
					</h2>
					<p className="mx-auto mt-6 max-w-[560px] text-balance text-[16px] leading-[1.65] text-[color:var(--fg-muted)] sm:text-[17px]">
						Free and open source under Apache&nbsp;2.0. Download it, point it at a repo, and merge your first
						agent-written PR tonight.
					</p>

					<div className="mt-9 flex w-full flex-col items-stretch justify-center gap-3 sm:w-auto sm:flex-row sm:items-center">
						{downloadTarget ? (
							<a
								href={downloadTarget.href}
								data-testid="cta-download-btn"
								className="hero-pressable btn-primary inline-flex h-12 w-full items-center justify-center gap-2 rounded-[6px] px-7 text-[15px] font-semibold sm:w-auto"
							>
								<DownloadIcon className="h-4 w-4" />
								{downloadTarget.label}
							</a>
						) : (
							<a
								href="https://github.com/AgentWrapper/agent-orchestrator/releases/latest"
								target="_blank"
								rel="noreferrer"
								data-testid="cta-download-btn"
								className="hero-pressable btn-primary inline-flex h-12 w-full items-center justify-center gap-2 rounded-[6px] px-7 text-[15px] font-semibold sm:w-auto"
							>
								<DownloadIcon className="h-4 w-4" />
								Download the app
							</a>
						)}
						<a
							href="https://github.com/AgentWrapper/agent-orchestrator"
							target="_blank"
							rel="noreferrer"
							data-testid="cta-github-btn"
							className="hero-pressable gh-star-btn group relative inline-flex h-12 w-full items-center justify-center gap-2 overflow-visible rounded-[6px] border border-[color:var(--border-strong)] bg-transparent px-7 text-[15px] font-semibold text-[color:var(--fg)] hover:border-[color:var(--accent-glow)] hover:bg-[color:var(--bg-card-hover)] sm:w-auto"
						>
							<GithubIcon className="h-4 w-4" />
							<span>Star on GitHub</span>
							<StarIcon className="gh-star h-4 w-4 text-[color:var(--fg-muted)]" />
							<span
								className={`gh-star-count rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[12px] leading-none text-[color:var(--fg-muted)] ${stars ? "" : "hidden"}`}
							>
								{stars}
							</span>
						</a>
					</div>

					{showBrew ? (
						<div className="mt-6 flex justify-center">
							<CopyCommand
								command={BREW_INSTALL_COMMAND}
								label="brew install command"
								nowrap
								className="w-full sm:w-auto"
							/>
						</div>
					) : null}

					<p className="mt-7 font-mono text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-dim)]">
						macOS · Windows · Linux · nightly builds · no account required
					</p>
				</div>
			</div>
		</section>
	);
}
