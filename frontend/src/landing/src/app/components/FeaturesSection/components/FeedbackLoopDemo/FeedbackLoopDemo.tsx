"use client";

import { AnimatePresence, motion } from "motion/react";
import {
	Check,
	CircleAlert,
	GitPullRequest,
	MessageSquare,
	RotateCw,
	Terminal,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
	FeaturePreviewShell,
	StatusDot,
	previewStatus,
} from "../FeaturePreviewShell";

const states = [
	{
		label: "CI failed",
		color: previewStatus.error,
		event: "test / web",
		detail: "AuthCallback › rejects expired state",
		terminal: [
			"observer  check failure received from PR #2481",
			"route     sending failure to owning Claude session",
			"agent     opening test/auth-callback.test.ts",
		],
	},
	{
		label: "Agent fixing",
		color: previewStatus.working,
		event: "Failure routed",
		detail: "Claude resumed with CI logs attached",
		terminal: [
			"read      callback handler and failing assertion",
			"edit      preserve state expiry before token exchange",
			"test      auth callback suite · 12 passed",
		],
	},
	{
		label: "Checks passed",
		color: previewStatus.success,
		event: "10 / 10 checks",
		detail: "New commit pushed to feat/github-auth",
		terminal: [
			"commit    fix(auth): reject expired callback state",
			"push      feat/github-auth",
			"observer  all required checks passed",
		],
	},
	{
		label: "Approved",
		color: previewStatus.accent,
		event: "Review resolved",
		detail: "Ready to merge",
		terminal: [
			"review    comment thread resolved",
			"review    approval received from codex",
			"queue     PR #2481 is ready to merge",
		],
	},
] as const;

export function FeedbackLoopDemo() {
	const [active, setActive] = useState(0);

	useEffect(() => {
		const interval = window.setInterval(
			() => setActive((current) => (current + 1) % states.length),
			2300,
		);
		return () => window.clearInterval(interval);
	}, []);

	const state = states[active];

	return (
		<FeaturePreviewShell
			title="Session · Ship GitHub sign-in"
			trailing={
				<div className="flex items-center gap-1.5 text-[9px]" style={{ color: state.color }}>
					<StatusDot color={state.color} pulse={active === 1} />
					{state.label}
				</div>
			}
		>
			<div className="grid h-[318px] grid-cols-1 sm:grid-cols-[190px_minmax(0,1fr)]">
				<aside className="hidden border-r border-[var(--preview-border)] bg-[var(--preview-card)]/35 p-3 sm:block">
					<div className="flex items-center gap-2">
						<img
							src="/app-icons/coverage-claude-code.svg"
							alt=""
							className="size-4"
							draggable="false"
						/>
						<div className="min-w-0">
							<div className="truncate text-[10px] font-semibold">
								Claude worker
							</div>
							<div className="truncate font-mono text-[9px] text-[var(--preview-muted-foreground)]">
								feat/github-auth
							</div>
						</div>
					</div>

					<div className="mt-4 text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--preview-muted-foreground)]">
						PR #2481
					</div>
					<div className="mt-2 space-y-1.5">
						{states.map((item, index) => {
							const complete = index < active;
							const isActive = index === active;
							return (
								<button
									type="button"
									key={item.label}
									onClick={() => setActive(index)}
									className={`relative flex w-full items-start gap-2 rounded-md border px-2 py-2 text-left outline-none transition-colors ${
										isActive
											? "border-[var(--preview-ring)] bg-[var(--preview-muted)]"
											: "border-transparent hover:bg-[var(--preview-muted)]/60"
									} focus-visible:ring-2 focus-visible:ring-[var(--preview-ring)]`}
								>
									<div className="mt-0.5">
										{complete ? (
											<Check className="size-3 text-[#74b98a]" />
										) : index === 0 ? (
											<CircleAlert
												className="size-3"
												style={{ color: isActive ? item.color : "#737373" }}
											/>
										) : index === 3 ? (
											<MessageSquare
												className="size-3"
												style={{ color: isActive ? item.color : "#737373" }}
											/>
										) : (
											<StatusDot
												color={isActive ? item.color : "#737373"}
												pulse={isActive}
											/>
										)}
									</div>
									<div className="min-w-0">
										<div className="truncate text-[9px] font-medium">
											{item.event}
										</div>
										<div className="mt-0.5 truncate text-[9px] text-[var(--preview-muted-foreground)]">
											{item.label}
										</div>
									</div>
								</button>
							);
						})}
					</div>
				</aside>

				<section className="flex min-w-0 flex-col p-3 sm:p-3.5">
					<div className="flex items-start justify-between gap-3 rounded-lg border border-[var(--preview-border)] bg-[var(--preview-card)] p-3">
						<div className="min-w-0">
							<div className="flex items-center gap-2 text-[10px] font-semibold">
								<GitPullRequest className="size-3.5" />
								<span className="truncate">{state.event}</span>
							</div>
							<p className="mt-1.5 truncate text-[9px] text-[var(--preview-muted-foreground)]">
								{state.detail}
							</p>
						</div>
						<motion.div
							key={state.label}
							initial={{ opacity: 0, scale: 0.9 }}
							animate={{ opacity: 1, scale: 1 }}
							className="shrink-0 rounded px-1.5 py-1 font-mono text-[9px]"
							style={{
								backgroundColor: `color-mix(in srgb, ${state.color} 16%, transparent)`,
								color: state.color,
							}}
						>
							{state.label}
						</motion.div>
					</div>

					<div className="mt-3 min-h-0 flex-1 overflow-hidden rounded-lg border border-[var(--preview-border)] bg-black/20">
						<div className="flex h-8 items-center gap-2 border-b border-[var(--preview-border)] px-3 text-[9px] text-[var(--preview-muted-foreground)]">
							<Terminal className="size-3" />
							Agent output
							<RotateCw
								className={`ml-auto size-3 ${active === 1 ? "animate-spin" : ""}`}
							/>
						</div>
						<AnimatePresence mode="wait" initial={false}>
							<motion.div
								key={active}
								initial={{ opacity: 0, y: 6 }}
								animate={{ opacity: 1, y: 0 }}
								exit={{ opacity: 0, y: -4 }}
								transition={{ duration: 0.22 }}
								className="space-y-3 p-3 font-mono text-[9px] leading-4"
							>
								{state.terminal.map((line, index) => {
									const [command, ...rest] = line.split(/\s+/);
									return (
										<motion.div
											key={line}
											initial={{ opacity: 0, x: -4 }}
											animate={{ opacity: 1, x: 0 }}
											transition={{ delay: index * 0.11 }}
											className="flex gap-3"
										>
											<span className="w-12 shrink-0 text-[#7eaaff]">
												{command}
											</span>
											<span className="text-[var(--preview-muted-foreground)]">
												{rest.join(" ")}
											</span>
										</motion.div>
									);
								})}
								{active < 3 ? (
									<div className="flex items-center gap-2 text-[var(--preview-muted-foreground)]/65">
										<span className="size-2 animate-spin rounded-full border border-current border-t-transparent" />
										watching GitHub…
									</div>
								) : (
									<div className="flex items-center gap-2 text-[#74b98a]">
										<Check className="size-3" />
										feedback loop complete
									</div>
								)}
							</motion.div>
						</AnimatePresence>
					</div>
				</section>
			</div>
		</FeaturePreviewShell>
	);
}
