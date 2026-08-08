"use client";

import { AnimatePresence, motion } from "motion/react";
import { Bot, Check, ChevronDown, Network, RefreshCw } from "lucide-react";
import Image from "next/image";
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
type SelectableEntry = { harness: Harness; index: number };

function isSelectable(status: Harness["status"]) {
	return status === "Authorized";
}

const SELECTABLE: SelectableEntry[] = [];
for (let index = 0; index < harnesses.length; index++) {
	const harness = harnesses[index];
	if (harness && isSelectable(harness.status)) {
		SELECTABLE.push({ harness, index });
	}
}

const DEFAULT_INDEX = SELECTABLE[0]?.index ?? 0;

function nextSelectable(value: number) {
	const position = SELECTABLE.findIndex((entry) => entry.index === value);
	const next = SELECTABLE[(position + 1) % SELECTABLE.length];
	return next?.index ?? value;
}

function otherField(field: Field): Field {
	return field === "worker" ? "orchestrator" : "worker";
}

function HarnessIcon({ src }: { src: string }) {
	return (
		<Image
			src={src}
			alt=""
			width={14}
			height={14}
			className="size-3.5 shrink-0"
			draggable={false}
		/>
	);
}

export function HarnessCoverageDemo() {
	const rootRef = useRef<HTMLDivElement>(null);
	const [openField, setOpenField] = useState<Field | null>("orchestrator");
	const [worker, setWorker] = useState(DEFAULT_INDEX);
	const [orchestrator, setOrchestrator] = useState(DEFAULT_INDEX);
	const [refreshing, setRefreshing] = useState(false);

	const openFieldRef = useRef<Field | null>("orchestrator");
	const workerRef = useRef(DEFAULT_INDEX);
	const orchestratorRef = useRef(DEFAULT_INDEX);
	const interactingRef = useRef(false);
	const inViewRef = useRef(true);
	const refreshTimerRef = useRef(0);

	useEffect(() => {
		openFieldRef.current = openField;
	}, [openField]);

	useEffect(() => {
		workerRef.current = worker;
	}, [worker]);

	useEffect(() => {
		orchestratorRef.current = orchestrator;
	}, [orchestrator]);

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
		let current: Field = openFieldRef.current ?? "orchestrator";
		let phase: "open" | "closed" = "open";
		let remaining = OPEN_MS;

		const isPaused = () => interactingRef.current || !inViewRef.current;

		const openNext = (field: Field) => {
			if (field === "worker") {
				setWorker(nextSelectable(workerRef.current));
			} else {
				setOrchestrator(nextSelectable(orchestratorRef.current));
			}
			setOpenField(field);
			current = field;
			phase = "open";
			remaining = OPEN_MS;
		};

		const tick = () => {
			if (cancelled) return;

			if (isPaused()) {
				timeoutId = window.setTimeout(tick, POLL_MS);
				return;
			}

			// Resync if the user opened/closed a menu while we were paused.
			if (phase === "open") {
				if (openFieldRef.current === null) {
					openNext(otherField(current));
					timeoutId = window.setTimeout(tick, POLL_MS);
					return;
				}
				if (openFieldRef.current !== current) {
					current = openFieldRef.current;
					remaining = OPEN_MS;
					timeoutId = window.setTimeout(tick, POLL_MS);
					return;
				}
			} else if (openFieldRef.current !== null) {
				current = openFieldRef.current;
				phase = "open";
				remaining = OPEN_MS;
				timeoutId = window.setTimeout(tick, POLL_MS);
				return;
			}

			remaining -= POLL_MS;
			if (remaining > 0) {
				timeoutId = window.setTimeout(tick, POLL_MS);
				return;
			}

			if (phase === "open") {
				setOpenField(null);
				phase = "closed";
				remaining = CLOSED_MS;
			} else {
				openNext(otherField(current));
			}

			timeoutId = window.setTimeout(tick, POLL_MS);
		};

		timeoutId = window.setTimeout(tick, POLL_MS);

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
				<span className="font-mono text-[9px] text-[var(--preview-muted-foreground)]">25 supported</span>
			}
		>
			<div
				ref={rootRef}
				className="relative h-[300px] overflow-hidden p-3 sm:h-[280px]"
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
					<h2 className="text-[9px] font-bold uppercase leading-4 tracking-[0.06em] text-[var(--preview-muted-foreground)]">
						Agents
					</h2>

					<SettingsRow
						icon={<Bot className="size-3.5 shrink-0 text-[var(--preview-muted-foreground)]" aria-hidden="true" />}
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
						icon={<Network className="size-3.5 shrink-0 text-[var(--preview-muted-foreground)]" aria-hidden="true" />}
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
						icon={<RefreshCw className="size-3.5 shrink-0 text-[var(--preview-muted-foreground)]" aria-hidden="true" />}
						label="Refresh agents"
						trailing={
							<button
								type="button"
								onClick={refresh}
								className="inline-flex items-center gap-1.5 rounded-lg px-1 py-0.5 text-[10px] text-[var(--preview-muted-foreground)] outline-none transition-colors hover:text-[var(--preview-foreground)] focus-visible:ring-2 focus-visible:ring-[var(--preview-ring)]"
							>
								<RefreshCw className={`size-3 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
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
						className={`absolute right-3 z-10 flex max-h-[180px] w-[min(16rem,calc(100%-24px))] flex-col overflow-hidden rounded-[12px] border border-[var(--preview-border)] bg-[var(--preview-muted)] p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.5)] ${
							openField === "worker" ? "top-[50px]" : "top-[94px]"
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
										className={`flex min-h-8 w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--preview-ring)] disabled:cursor-not-allowed ${
											selected
												? "bg-[color-mix(in_oklab,var(--preview-foreground)_12%,transparent)]"
												: "hover:bg-[color-mix(in_oklab,var(--preview-foreground)_8%,transparent)]"
										} ${disabled ? "opacity-45" : ""}`}
									>
										<HarnessIcon src={harness.icon} />
										<span
											className={`min-w-0 flex-1 truncate text-[11px] ${
												disabled
													? "text-[var(--preview-muted-foreground)]"
													: "text-[var(--preview-foreground)]"
											}`}
										>
											{harness.label}
										</span>
										<span
											className="shrink-0 text-[9.5px]"
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
											<Check className="size-2.5 shrink-0 text-[var(--preview-foreground)]" aria-hidden="true" />
										) : null}
									</button>
									);
								})}
							</div>
						</motion.div>
					) : null}
				</AnimatePresence>

			<div className="absolute bottom-3 left-3 right-3 flex items-center justify-between border-t border-[var(--preview-border)] pt-2.5">
				<span className="hidden text-[8.5px] text-[var(--preview-muted-foreground)] sm:block">
					Selections apply to new sessions.
				</span>
				<button
					type="button"
					className="h-[26px] rounded-xl bg-[#4f8afa] px-3 text-[10px] font-medium text-white outline-none transition-transform active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-[var(--preview-ring)]"
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
		<div className="flex h-[36px] items-center justify-between gap-3 rounded-xl bg-[var(--preview-card)] px-3 transition-[background-color,box-shadow] duration-150">
			<div className="flex min-w-0 items-center gap-2.5">
				{icon}
				<span className="truncate text-[11px] leading-5 text-[var(--preview-foreground)]">{label}</span>
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
			className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-xl px-1 py-0.5 text-left text-[10px] text-[var(--preview-muted-foreground)] outline-none transition-colors hover:text-[var(--preview-foreground)] focus-visible:ring-2 focus-visible:ring-[var(--preview-ring)]"
		>
			<HarnessIcon src={harness.icon} />
			<span className="min-w-0 truncate">{harness.label}</span>
			<ChevronDown
				className={`size-2.5 shrink-0 opacity-70 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
				aria-hidden="true"
			/>
		</button>
	);
}
