"use client";

import { AnimatePresence, motion } from "motion/react";
import { Bot, Check, ChevronDown, Network, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { FeaturePreviewShell, previewStatus } from "../FeaturePreviewShell";

const OPEN_MS = 1800;
const CLOSED_MS = 1800;
const POLL_MS = 100;

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
type Harness = (typeof harnesses)[number];

function isSelectable(status: Harness["status"]) {
	return status === "Authorized";
}

const SELECTABLE = harnesses
	.map((harness, index) => ({ harness, index }))
	.filter(({ harness }) => isSelectable(harness.status));

const DEFAULT_INDEX = SELECTABLE[0]?.index ?? 0;

function nextSelectable(value: number) {
	const position = SELECTABLE.findIndex((entry) => entry.index === value);
	const next = SELECTABLE[(position + 1) % SELECTABLE.length];
	return next?.index ?? value;
}

function otherField(field: Field): Field {
	return field === "worker" ? "orchestrator" : "worker";
}

export function HarnessCoverageDemo() {
	const rootRef = useRef<HTMLDivElement>(null);
	const [openField, setOpenField] = useState<Field | null>("orchestrator");
	const [worker, setWorker] = useState(DEFAULT_INDEX);
	const [orchestrator, setOrchestrator] = useState(DEFAULT_INDEX);
	const [refreshing, setRefreshing] = useState(false);

	const openFieldRef = useRef<Field | null>(openField);
	const workerRef = useRef(worker);
	const orchestratorRef = useRef(orchestrator);
	const interactingRef = useRef(false);
	const inViewRef = useRef(true);
	const refreshTimerRef = useRef(0);

	openFieldRef.current = openField;
	workerRef.current = worker;
	orchestratorRef.current = orchestrator;

	useEffect(() => {
		const node = rootRef.current;
		if (!node || typeof IntersectionObserver === "undefined") return;

		const observer = new IntersectionObserver(
			([entry]) => {
				inViewRef.current = entry?.isIntersecting ?? true;
			},
			{ threshold: 0.2 },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		let cancelled = false;
		let timeoutId = 0;

		const wait = (ms: number) =>
			new Promise<void>((resolve) => {
				timeoutId = window.setTimeout(resolve, ms);
			});

		const isPaused = () => interactingRef.current || !inViewRef.current;

		/** Counts down only while idle and on-screen; freezes otherwise. */
		const waitWhileIdle = async (ms: number) => {
			let remaining = ms;
			while (!cancelled && remaining > 0) {
				if (isPaused()) {
					await wait(POLL_MS);
					continue;
				}
				const slice = Math.min(POLL_MS, remaining);
				await wait(slice);
				remaining -= slice;
			}
		};

		const waitUntilIdle = async () => {
			while (!cancelled && isPaused()) {
				await wait(POLL_MS);
			}
		};

		void (async () => {
			let current: Field = openFieldRef.current ?? "orchestrator";

			while (!cancelled) {
				// If the user left the menu closed, reopen the next field in the cycle.
				if (openFieldRef.current === null) {
					await waitUntilIdle();
					if (cancelled) break;
					current = otherField(current);
					if (current === "worker") {
						setWorker(nextSelectable(workerRef.current));
					} else {
						setOrchestrator(nextSelectable(orchestratorRef.current));
					}
					setOpenField(current);
				} else {
					current = openFieldRef.current;
				}

				await waitWhileIdle(OPEN_MS);
				if (cancelled) break;

				// User took over mid-open — resync and restart the open phase.
				if (isPaused() || openFieldRef.current !== current) {
					await waitUntilIdle();
					continue;
				}

				setOpenField(null);

				await waitWhileIdle(CLOSED_MS);
				if (cancelled) break;

				if (isPaused() || openFieldRef.current !== null) {
					await waitUntilIdle();
					continue;
				}

				current = otherField(current);
				if (current === "worker") {
					setWorker(nextSelectable(workerRef.current));
				} else {
					setOrchestrator(nextSelectable(orchestratorRef.current));
				}
				setOpenField(current);
			}
		})();

		return () => {
			cancelled = true;
			window.clearTimeout(timeoutId);
		};
	}, []);

	useEffect(() => {
		return () => {
			window.clearTimeout(refreshTimerRef.current);
		};
	}, []);

	const setInteracting = (value: boolean) => {
		interactingRef.current = value;
	};

	const chooseHarness = (index: number) => {
		const harness = harnesses[index];
		if (!harness || !isSelectable(harness.status)) return;
		if (openField === "worker") setWorker(index);
		if (openField === "orchestrator") setOrchestrator(index);
		setOpenField(null);
	};

	const refresh = () => {
		window.clearTimeout(refreshTimerRef.current);
		setRefreshing(true);
		refreshTimerRef.current = window.setTimeout(() => setRefreshing(false), 900);
	};

	const toggleField = (field: Field) => {
		setOpenField((current) => (current === field ? null : field));
	};

	return (
		<FeaturePreviewShell
			title="Agent Orchestrator"
			trailing={
				<span className="font-mono text-[9px] text-[var(--preview-muted-foreground)]">23 supported</span>
			}
		>
			<div
				ref={rootRef}
				className="relative h-[340px] overflow-hidden p-3 sm:h-[318px] sm:p-4"
				onPointerEnter={() => setInteracting(true)}
				onPointerLeave={() => setInteracting(false)}
				onFocusCapture={() => setInteracting(true)}
				onBlurCapture={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
						setInteracting(false);
					}
				}}
			>
				<div className="flex flex-col gap-1.5">
					<h2 className="text-[10px] font-bold uppercase leading-4 tracking-[0.06em] text-[var(--preview-muted-foreground)]">
						Agents
					</h2>

					<SettingsRow
						icon={<Bot className="size-4 shrink-0 text-[var(--preview-muted-foreground)]" aria-hidden="true" />}
						label="Default worker agent"
						trailing={
							<HarnessTrigger
								harness={harnesses[worker]}
								open={openField === "worker"}
								onClick={() => toggleField("worker")}
							/>
						}
					/>

					<SettingsRow
						icon={<Network className="size-4 shrink-0 text-[var(--preview-muted-foreground)]" aria-hidden="true" />}
						label="Default orchestrator agent"
						trailing={
							<HarnessTrigger
								harness={harnesses[orchestrator]}
								open={openField === "orchestrator"}
								onClick={() => toggleField("orchestrator")}
							/>
						}
					/>

					<SettingsRow
						icon={<RefreshCw className="size-4 shrink-0 text-[var(--preview-muted-foreground)]" aria-hidden="true" />}
						label="Refresh agents"
						trailing={
							<button
								type="button"
								onClick={refresh}
								className="inline-flex items-center gap-1.5 rounded-lg px-1 py-0.5 text-[11px] text-[var(--preview-muted-foreground)] outline-none transition-colors hover:text-[var(--preview-foreground)] focus-visible:ring-2 focus-visible:ring-[var(--preview-ring)]"
							>
								<RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
								{refreshing ? "Refreshing…" : "Refresh"}
							</button>
						}
					/>
				</div>

				<AnimatePresence mode="wait">
					{openField ? (
						<motion.div
							key={openField}
							initial={{ opacity: 0, y: -6, scale: 0.98 }}
							animate={{ opacity: 1, y: 0, scale: 1 }}
							exit={{ opacity: 0, y: -4, scale: 0.98 }}
							transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
							className={`absolute right-3 z-10 flex max-h-[200px] w-[min(18rem,calc(100%-24px))] flex-col overflow-hidden rounded-[14px] border border-[var(--preview-border)] bg-[var(--preview-muted)] p-2 shadow-[0_16px_40px_rgba(0,0,0,0.5)] sm:right-4 ${
								openField === "worker" ? "top-[58px] sm:top-[62px]" : "top-[106px] sm:top-[110px]"
							}`}
						>
							<div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
								{harnesses.map((harness, index) => {
									const selected =
										openField === "worker" ? worker === index : orchestrator === index;
									const disabled = !isSelectable(harness.status);
									return (
										<button
											type="button"
											key={harness.id}
											disabled={disabled}
											onClick={() => chooseHarness(index)}
											className={`flex min-h-9 w-full items-center gap-3 rounded-2xl px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--preview-ring)] disabled:cursor-not-allowed ${
												selected
													? "bg-[color-mix(in_oklab,var(--preview-foreground)_12%,transparent)]"
													: "hover:bg-[color-mix(in_oklab,var(--preview-foreground)_8%,transparent)]"
											} ${disabled ? "opacity-45" : ""}`}
										>
											<img src={harness.icon} alt="" className="size-4 shrink-0" draggable="false" />
											<span
												className={`min-w-0 flex-1 truncate text-[12px] ${
													disabled
														? "text-[var(--preview-muted-foreground)]"
														: "text-[var(--preview-foreground)]"
												}`}
											>
												{harness.label}
											</span>
											<span
												className="shrink-0 text-[10px]"
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
												<Check className="size-3 shrink-0 text-[var(--preview-foreground)]" aria-hidden="true" />
											) : null}
										</button>
									);
								})}
							</div>
						</motion.div>
					) : null}
				</AnimatePresence>

				<div className="absolute bottom-3 left-3 right-3 flex items-center justify-between border-t border-[var(--preview-border)] pt-3 sm:bottom-4 sm:left-4 sm:right-4">
					<span className="hidden text-[9px] text-[var(--preview-muted-foreground)] sm:block">
						Selections apply to new sessions.
					</span>
					<button
						type="button"
						className="h-8 rounded-2xl bg-[#4f8afa] px-4 text-[11px] font-medium text-white outline-none transition-transform active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-[var(--preview-ring)]"
					>
						Save changes
					</button>
				</div>
			</div>
		</FeaturePreviewShell>
	);
}

function SettingsRow({
	icon,
	label,
	trailing,
}: {
	icon: ReactNode;
	label: string;
	trailing: ReactNode;
}) {
	return (
		<div className="flex h-[42px] items-center justify-between gap-3 rounded-2xl bg-[var(--preview-card)] px-3.5 transition-[background-color,box-shadow] duration-150">
			<div className="flex min-w-0 items-center gap-3">
				{icon}
				<span className="truncate text-[12px] leading-5 text-[var(--preview-foreground)]">{label}</span>
			</div>
			<div className="flex min-w-0 shrink-0 items-center justify-end">{trailing}</div>
		</div>
	);
}

function HarnessTrigger({
	harness,
	onClick,
	open,
}: {
	harness: Harness | undefined;
	onClick: () => void;
	open: boolean;
}) {
	if (!harness) return null;

	return (
		<button
			type="button"
			aria-expanded={open}
			onClick={onClick}
			className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-2xl px-1 py-0.5 text-left text-[11px] text-[var(--preview-muted-foreground)] outline-none transition-colors hover:text-[var(--preview-foreground)] focus-visible:ring-2 focus-visible:ring-[var(--preview-ring)]"
		>
			<img src={harness.icon} alt="" className="size-4 shrink-0" draggable="false" />
			<span className="min-w-0 truncate">{harness.label}</span>
			<ChevronDown
				className={`size-3 shrink-0 opacity-70 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
				aria-hidden="true"
			/>
		</button>
	);
}
