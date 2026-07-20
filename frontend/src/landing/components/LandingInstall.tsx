"use client";

import Link from "next/link";
import { DESKTOP_DOWNLOADS } from "../lib/desktop-downloads";
import { useDownloadTarget, useIsMacDesktop } from "../lib/use-download-target";
import { CopyCommand } from "./CopyCommand";

const BREW_INSTALL_COMMAND = "brew install --cask agentwrapper/tap/agent-orchestrator";

function DownloadIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="M12 3v12" />
			<path d="m7 10 5 5 5-5" />
			<path d="M5 21h14" />
		</svg>
	);
}

function AppleIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M17.05 12.54c-.03-2.89 2.36-4.27 2.47-4.34-1.35-1.97-3.44-2.24-4.18-2.27-1.78-.18-3.47 1.05-4.37 1.05-.9 0-2.29-1.02-3.77-1-1.94.03-3.72 1.13-4.72 2.86-2.01 3.49-.51 8.66 1.45 11.5.96 1.39 2.1 2.95 3.6 2.89 1.45-.06 2-.93 3.75-.93s2.25.93 3.78.9c1.56-.03 2.55-1.41 3.5-2.81 1.1-1.61 1.55-3.17 1.58-3.25-.04-.02-3.03-1.16-3.09-4.6ZM14.16 4.06c.8-.97 1.34-2.31 1.19-3.65-1.15.05-2.55.77-3.38 1.73-.74.85-1.39 2.23-1.22 3.54 1.29.1 2.6-.65 3.41-1.62Z" />
		</svg>
	);
}

function WindowsIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M3 5.5 10.5 4.4v7.1H3V5.5Zm0 13 7.5 1.1v-7.1H3v7Zm8.3 1.2L21 21v-8.5h-9.7v7.2ZM11.3 4.3 21 3v8.5h-9.7V4.3Z" />
		</svg>
	);
}

function LinuxIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M12 2c-1.7 0-3 .9-3.6 2.3-.3.6-.4 1.3-.4 2 0 .5 0 1 .1 1.4-.5.9-.9 1.9-1.1 2.9-.2.7-.3 1.4-.3 2 0 1.1.2 2.2.6 3.1-1 .6-1.6 1.3-1.6 2.1 0 .4.2.8.5 1.1-.3.3-.5.7-.5 1.1 0 1.2 1.7 2 4.1 2.3.8.1 1.5.1 2.2.1s1.4 0 2.2-.1c2.4-.3 4.1-1.1 4.1-2.3 0-.4-.2-.8-.5-1.1.3-.3.5-.7.5-1.1 0-.8-.6-1.5-1.6-2.1.4-.9.6-2 .6-3.1 0-.6-.1-1.3-.3-2-.2-1-.6-2-1.1-2.9.1-.4.1-.9.1-1.4 0-.7-.1-1.4-.4-2C15 2.9 13.7 2 12 2Zm-1.5 6c.3 0 .6.2.6.5s-.3.5-.6.5-.6-.2-.6-.5.3-.5.6-.5Zm3 0c.3 0 .6.2.6.5s-.3.5-.6.5-.6-.2-.6-.5.3-.5.6-.5Zm-1.5 2c.6 0 1.1.4 1.1.9 0 .6-.7 1.1-1.1 1.1s-1.1-.5-1.1-1.1c0-.5.5-.9 1.1-.9Z" />
		</svg>
	);
}

const platformIcons: Record<string, ({ className }: { className?: string }) => React.ReactNode> = {
	apple: AppleIcon,
	windows: WindowsIcon,
	linux: LinuxIcon,
};

export function LandingInstall() {
	const primary = useDownloadTarget();
	const mac = useIsMacDesktop();

	return (
		<section
			id="install"
			data-testid="install-section"
			className="landing-reveal relative border-t border-[color:var(--border)] pt-16 pb-16 sm:pt-[clamp(80px,9vw,128px)] sm:pb-[clamp(80px,9vw,128px)]"
		>
			<div className="container-page">
				<div className="mx-auto max-w-[1180px]">
					<div className="max-w-[720px]">
						<div className="landing-eyebrow mb-4">Quickstart</div>
						<h2 className="landing-heading">
							Zero to a fleet <span className="landing-heading-muted">in three steps.</span>
						</h2>
						<p className="landing-body-compact mt-5">
							No account, no cloud, no credit card. AO runs as a local daemon on your machine — your code never leaves
							localhost.
						</p>
					</div>

					<div className="mt-12 grid gap-4 lg:grid-cols-3">
						{/* Step 1 — install the app */}
						<div className="surface flex flex-col p-6">
							<div className="flex items-center justify-between">
								<span className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--accent)]">
									01
								</span>
								<span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[color:var(--fg-dim)]">
									~1 min
								</span>
							</div>
							<h3 className="mt-4 text-[17px] font-semibold tracking-[-0.01em] text-[color:var(--fg)]">
								Install the desktop app
							</h3>
							<p className="mt-2 text-[13.5px] leading-relaxed text-[color:var(--fg-muted)]">
								One cask on macOS, or grab the installer for your platform. The app runs and updates the daemon for you.
							</p>
							<div className="mt-auto flex flex-col gap-2.5 pt-5">
								{mac ? (
									<CopyCommand command={BREW_INSTALL_COMMAND} label="brew install command" className="w-full" />
								) : null}
								<div className="flex flex-wrap gap-2">
									{DESKTOP_DOWNLOADS.map((download) => {
										const Icon = platformIcons[download.logo] ?? DownloadIcon;
										const isPrimary = primary?.href === download.href;
										return (
											<a
												key={download.label}
												href={download.href}
												className={`inline-flex h-9 items-center gap-2 rounded-[6px] border px-3 text-[12px] font-medium transition-colors ${
													isPrimary
														? "border-[color:var(--accent-glow)] bg-[color:var(--accent-soft)] text-[color:var(--fg)]"
														: "border-[color:var(--border)] bg-white/[0.02] text-[color:var(--fg-muted)] hover:border-[color:var(--border-strong)] hover:text-[color:var(--fg)]"
												}`}
											>
												<Icon className="h-3.5 w-3.5" />
												{download.label}
											</a>
										);
									})}
								</div>
							</div>
						</div>

						{/* Step 2 — connect tools */}
						<div className="surface flex flex-col p-6">
							<div className="flex items-center justify-between">
								<span className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--accent)]">
									02
								</span>
								<span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[color:var(--fg-dim)]">
									~2 min
								</span>
							</div>
							<h3 className="mt-4 text-[17px] font-semibold tracking-[-0.01em] text-[color:var(--fg)]">
								Sign in to GitHub
							</h3>
							<p className="mt-2 text-[13.5px] leading-relaxed text-[color:var(--fg-muted)]">
								One command — AO reads issues, PRs, reviews, and CI as you. The agent CLI you already use just works.
								That's the whole setup.
							</p>
							<div className="mt-auto flex flex-col gap-2.5 pt-5">
								<CopyCommand command="gh auth login" label="GitHub CLI login command" className="w-full" />
							</div>
						</div>

						{/* Step 3 — spawn */}
						<div className="surface flex flex-col p-6">
							<div className="flex items-center justify-between">
								<span className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--accent)]">
									03
								</span>
								<span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[color:var(--fg-dim)]">
									ongoing
								</span>
							</div>
							<h3 className="mt-4 text-[17px] font-semibold tracking-[-0.01em] text-[color:var(--fg)]">
								Tell the orchestrator what you need
							</h3>
							<p className="mt-2 text-[13.5px] leading-relaxed text-[color:var(--fg-muted)]">
								Just say it in plain words. The orchestrator plans the work, spawns workers into their own worktrees,
								and you watch the PRs land on the board.
							</p>
							<div className="mt-auto flex flex-col gap-2.5 pt-5">
								<div className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg-deep)] px-4 py-3 text-[13px] leading-relaxed text-[color:var(--fg-muted)]">
									<span className="text-[color:var(--fg-dim)]">You → </span>
									<span className="italic text-[color:var(--fg)]">
										“Go through my Linear backlog and let’s brainstorm what tasks to spawn.”
									</span>
								</div>
								<Link
									href="/docs/quickstart"
									className="group inline-flex items-center gap-1.5 pt-1 text-[12.5px] font-medium text-[color:var(--accent)]"
								>
									Read the full quickstart
									<span aria-hidden="true" className="transition-transform duration-200 group-hover:translate-x-0.5">
										→
									</span>
								</Link>
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
