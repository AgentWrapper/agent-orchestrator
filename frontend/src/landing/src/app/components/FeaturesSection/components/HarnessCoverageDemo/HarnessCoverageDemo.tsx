"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, RefreshCw, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { FeaturePreviewShell, previewStatus } from "../FeaturePreviewShell";

const harnesses = [
	{
		id: "claude-code",
		label: "Claude Code",
		icon: "/app-icons/coverage-claude-code.svg",
		status: "Authorized",
	},
	{
		id: "codex",
		label: "Codex",
		icon: "/app-icons/coverage-codex.svg",
		status: "Authorized",
	},
	{
		id: "cursor",
		label: "Cursor",
		icon: "/app-icons/coverage-cursor.svg",
		status: "Authorized",
	},
	{
		id: "opencode",
		label: "OpenCode",
		icon: "/app-icons/coverage-opencode.svg",
		status: "Authorized",
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		icon: "/app-icons/coverage-gemini.svg",
		status: "Needs auth",
	},
] as const;

type Field = "worker" | "orchestrator";

export function HarnessCoverageDemo() {
	const [openField, setOpenField] = useState<Field | null>("worker");
	const [worker, setWorker] = useState(0);
	const [orchestrator, setOrchestrator] = useState(1);
	const [refreshing, setRefreshing] = useState(false);

	useEffect(() => {
		const interval = window.setInterval(() => {
			setOpenField((current) => {
				const nextField = current === "worker" ? "orchestrator" : "worker";
				if (nextField === "worker") {
					setWorker((value) => (value + 1) % 4);
				} else {
					setOrchestrator((value) => (value + 1) % 4);
				}
				return nextField;
			});
		}, 3200);
		return () => window.clearInterval(interval);
	}, []);

	const chooseHarness = (index: number) => {
		if (openField === "worker") setWorker(index);
		if (openField === "orchestrator") setOrchestrator(index);
		setOpenField(null);
	};

	const refresh = () => {
		setRefreshing(true);
		window.setTimeout(() => setRefreshing(false), 900);
	};

	return (
		<FeaturePreviewShell
			title="Project settings · Agents"
			trailing={
				<span className="font-mono text-[9px] text-[var(--preview-muted-foreground)]">
					23 supported
				</span>
			}
		>
			<div className="relative h-[340px] p-3 sm:h-[318px] sm:p-4">
				<div className="flex items-center gap-2">
					<div className="grid size-8 place-items-center rounded-lg border border-[var(--preview-border)] bg-[var(--preview-muted)]">
						<Settings2 className="size-4" />
					</div>
					<div>
						<div className="text-[12px] font-semibold tracking-[-0.4px]">
							Agents
						</div>
						<div className="text-[9px] text-[var(--preview-muted-foreground)]">
							Choose a harness per role. Change it any time.
						</div>
					</div>
				</div>

				<div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
					<HarnessField
						label="Default worker agent"
						harness={harnesses[worker]}
						open={openField === "worker"}
						onClick={() =>
							setOpenField((current) => (current === "worker" ? null : "worker"))
						}
					/>
					<div className="hidden sm:block">
						<HarnessField
							label="Orchestrator agent"
							harness={harnesses[orchestrator]}
							open={openField === "orchestrator"}
							onClick={() =>
								setOpenField((current) =>
									current === "orchestrator" ? null : "orchestrator",
								)
							}
						/>
					</div>
				</div>

				<div className="mt-3 flex items-center justify-between text-[9px] text-[var(--preview-muted-foreground)]">
					<span>Agent availability is cached.</span>
					<button
						type="button"
						onClick={refresh}
						className="inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-[var(--preview-foreground)] outline-none transition-colors hover:bg-[var(--preview-muted)] focus-visible:ring-2 focus-visible:ring-[var(--preview-ring)]"
					>
						<RefreshCw className={`size-3 ${refreshing ? "animate-spin" : ""}`} />
						{refreshing ? "Refreshing…" : "Refresh agents"}
					</button>
				</div>

				<AnimatePresence>
					{openField ? (
						<motion.div
							key={openField}
							initial={{ opacity: 0, y: -5, scale: 0.98 }}
							animate={{ opacity: 1, y: 0, scale: 1 }}
							exit={{ opacity: 0, y: -3, scale: 0.98 }}
							transition={{ duration: 0.16 }}
							className={`absolute left-3 right-3 top-[132px] z-10 overflow-hidden rounded-lg border border-[var(--preview-border)] bg-[var(--preview-card)] p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.5)] sm:top-[130px] sm:w-[calc(50%_-_22px)] sm:min-w-[220px] ${
								openField === "worker"
									? "sm:left-4 sm:right-auto"
									: "sm:left-auto sm:right-4"
							}`}
						>
							{harnesses.map((harness, index) => {
								const selected =
									openField === "worker" ? worker === index : orchestrator === index;
								const disabled = harness.status === "Needs auth";
								return (
									<button
										type="button"
										key={harness.id}
										disabled={disabled}
										onClick={() => chooseHarness(index)}
										className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors hover:bg-[var(--preview-muted)] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:ring-2 focus-visible:ring-[var(--preview-ring)]"
									>
										<img
											src={harness.icon}
											alt=""
											className="size-4"
											draggable="false"
										/>
										<span className="min-w-0 flex-1 truncate text-[10px]">
											{harness.label}
										</span>
										<span
											className="text-[9px]"
											style={{
												color:
													harness.status === "Authorized"
														? previewStatus.success
														: previewStatus.warning,
											}}
										>
											{harness.status}
										</span>
										{selected ? (
											<Check className="size-3 shrink-0 text-[var(--preview-foreground)]" />
										) : null}
									</button>
								);
							})}
							<div className="mt-1 border-t border-[var(--preview-border)] px-2 pt-2 text-[9px] text-[var(--preview-muted-foreground)]">
								18 more harnesses available
							</div>
						</motion.div>
					) : null}
				</AnimatePresence>

				<div className="absolute bottom-3 left-3 right-3 flex items-center justify-end border-t border-[var(--preview-border)] pt-3 sm:bottom-4 sm:left-4 sm:right-4 sm:justify-between">
					<span className="hidden text-[9px] text-[var(--preview-muted-foreground)] sm:block">
						Selections apply to new sessions.
					</span>
					<button
						type="button"
						className="h-7 rounded-md bg-[var(--preview-primary)] px-3 text-[10px] font-semibold text-[var(--preview-primary-foreground)] outline-none transition-transform active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-[var(--preview-ring)]"
					>
						Save changes
					</button>
				</div>
			</div>
		</FeaturePreviewShell>
	);
}

function HarnessField({
	harness,
	label,
	onClick,
	open,
}: {
	harness: (typeof harnesses)[number];
	label: string;
	onClick: () => void;
	open: boolean;
}) {
	return (
		<div>
			<div className="mb-1.5 text-[9px] font-medium text-[var(--preview-muted-foreground)]">
				{label}
			</div>
			<button
				type="button"
				aria-expanded={open}
				onClick={onClick}
				className={`flex h-9 w-full items-center gap-2 rounded-md border bg-[var(--preview-card)] px-2.5 text-left outline-none transition-colors ${
					open
						? "border-[var(--preview-ring)]"
						: "border-[var(--preview-border)] hover:bg-[var(--preview-muted)]"
				} focus-visible:ring-2 focus-visible:ring-[var(--preview-ring)]`}
			>
				<img src={harness.icon} alt="" className="size-4" draggable="false" />
				<span className="min-w-0 flex-1 truncate text-[10px]">
					{harness.label}
				</span>
				<ChevronDown
					className={`size-3 text-[var(--preview-muted-foreground)] transition-transform ${
						open ? "rotate-180" : ""
					}`}
				/>
			</button>
		</div>
	);
}
