"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, GitBranch, LoaderCircle, Network, Send } from "lucide-react";
import { useEffect, useState } from "react";
import {
	FeaturePreviewShell,
	StatusDot,
	previewStatus,
} from "../FeaturePreviewShell";

const workers = [
	{
		agent: "Claude",
		branch: "feat/auth-callback",
		icon: "/app-icons/coverage-claude-code.svg",
		task: "Build callback route",
	},
	{
		agent: "Codex",
		branch: "test/auth-flow",
		icon: "/app-icons/coverage-codex.svg",
		task: "Add integration tests",
	},
	{
		agent: "Cursor",
		branch: "docs/auth-setup",
		icon: "/app-icons/coverage-cursor.svg",
		task: "Update setup guide",
	},
] as const;

const brief =
	"Ship GitHub sign-in, cover the callback flow, and update the setup docs.";

export function DelegationDemo() {
	const [stage, setStage] = useState(0);

	useEffect(() => {
		const interval = window.setInterval(
			() => setStage((current) => (current + 1) % 3),
			2100,
		);
		return () => window.clearInterval(interval);
	}, []);

	return (
		<FeaturePreviewShell
			title="AgentWrapper / agent-orchestrator"
			trailing={
				<span className="rounded border border-[var(--preview-border)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--preview-muted-foreground)]">
					Orchestrator
				</span>
			}
		>
			<div className="grid h-[340px] grid-cols-1 sm:h-[318px] sm:grid-cols-[minmax(0,1.08fr)_minmax(176px,0.72fr)]">
				<section className="flex min-w-0 flex-col p-3 sm:border-r sm:border-[var(--preview-border)] sm:p-4">
					<div className="flex items-center gap-2.5">
						<div className="grid size-8 place-items-center rounded-lg border border-[var(--preview-border)] bg-[var(--preview-muted)]">
							<Network className="size-4 text-[var(--preview-foreground)]" />
						</div>
						<div>
							<div className="text-[12px] font-semibold tracking-[-0.4px]">
								AO Orchestrator
							</div>
							<div className="text-[9px] text-[var(--preview-muted-foreground)]">
								Plans the work. Routes the fleet.
							</div>
						</div>
					</div>

					<div className="mt-4 rounded-lg border border-[var(--preview-border)] bg-[var(--preview-card)] p-3">
						<div className="text-[9px] font-medium uppercase tracking-[0.08em] text-[var(--preview-muted-foreground)]">
							Outcome
						</div>
						<p className="mt-2 text-[11px] leading-[17px] text-[var(--preview-card-foreground)]">
							{brief}
						</p>
						<button
							type="button"
							onClick={() => setStage(0)}
							className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md bg-[var(--preview-primary)] px-2.5 text-[10px] font-semibold text-[var(--preview-primary-foreground)] outline-none transition-transform active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-[var(--preview-ring)]"
						>
							<Send className="size-3" />
							Delegate
						</button>
					</div>

					<div className="mt-3 min-h-0 flex-1 rounded-lg border border-[var(--preview-border)] bg-black/10 p-3 font-mono text-[10px] leading-5">
						<AnimatePresence mode="popLayout" initial={false}>
							<motion.div
								key={stage}
								initial={{ opacity: 0, y: 4 }}
								animate={{ opacity: 1, y: 0 }}
								exit={{ opacity: 0, y: -3 }}
								transition={{ duration: 0.2 }}
							>
								{stage === 0 ? (
									<div className="flex items-center gap-2 text-[var(--preview-muted-foreground)]">
										<LoaderCircle className="size-3 animate-spin text-[var(--preview-accent)]" />
										Reading project context…
									</div>
								) : (
									<div className="space-y-1">
										<div className="flex items-center gap-2 text-[var(--preview-muted-foreground)]">
											<Check className="size-3 text-[#74b98a]" />
											Plan split into 3 isolated tracks
										</div>
										<div className="text-[var(--preview-muted-foreground)]/70">
											<span className="text-[#7eaaff]">next</span>{" "}
											{stage === 1
												? "creating worktrees…"
												: "watch checks and route blockers"}
										</div>
									</div>
								)}
							</motion.div>
						</AnimatePresence>
					</div>
				</section>

				<aside className="hidden min-w-0 bg-[var(--preview-background)] p-3 sm:block">
					<div className="flex items-center justify-between">
						<span className="text-[10px] font-semibold text-[var(--preview-muted-foreground)]">
							Worker queue
						</span>
						<span className="font-mono text-[9px] text-[var(--preview-muted-foreground)]/60">
							{stage === 2 ? "3 running" : "preparing"}
						</span>
					</div>
					<div className="mt-3 space-y-2">
						{workers.map((worker, index) => (
							<motion.button
								type="button"
								key={worker.branch}
								onClick={() => setStage(2)}
								initial={false}
								animate={{
									opacity: stage === 2 ? 1 : 0.38,
									x: stage === 2 ? 0 : 8,
								}}
								transition={{
									duration: 0.3,
									delay: stage === 2 ? index * 0.1 : 0,
								}}
								className="w-full rounded-lg border border-[var(--preview-border)] bg-[var(--preview-card)] p-2.5 text-left outline-none transition-colors hover:bg-[var(--preview-muted)] focus-visible:ring-2 focus-visible:ring-[var(--preview-ring)]"
							>
								<div className="flex items-center gap-2">
									<img
										src={worker.icon}
										alt=""
										className="size-3.5"
										draggable="false"
									/>
									<span className="min-w-0 flex-1 truncate text-[10px] font-medium">
										{worker.task}
									</span>
									<StatusDot
										color={stage === 2 ? previewStatus.working : "#6b7280"}
										pulse={stage === 2}
									/>
								</div>
								<div className="mt-2 flex items-center gap-1.5 truncate font-mono text-[9px] text-[var(--preview-muted-foreground)]">
									<GitBranch className="size-2.5 shrink-0" />
									{worker.branch}
								</div>
							</motion.button>
						))}
					</div>
				</aside>
			</div>
		</FeaturePreviewShell>
	);
}
