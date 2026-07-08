import { type ReactNode } from "react";
import { Plus } from "lucide-react";
import { useShell } from "../lib/shell-context";
import aoLogo from "../assets/ao-logo.png";
import { CreateProjectFlow } from "./CreateProjectFlow";
import { OrchestratorIcon } from "./icons";

const FLOW: { label: string; color: string }[] = [
	{ label: "Working", color: "var(--orange)" },
	{ label: "Needs you", color: "var(--amber)" },
	{ label: "In review", color: "var(--fg-passive)" },
	{ label: "Ready to merge", color: "var(--green)" },
];

export function BoardWelcome() {
	const { createProject } = useShell();
	return (
		<div className="flex h-full min-h-0 items-center justify-center overflow-y-auto">
			<div className="flex w-full max-w-[460px] flex-col items-center pb-[6vh] text-center">
				<img src={aoLogo} alt="" aria-hidden="true" className="h-8 w-8 rounded-[8px] object-cover" />
				<h2 className="mt-4 text-[15px] font-semibold tracking-[-0.01em] text-foreground">
					Agent Orchestrator
				</h2>
				<p className="mt-1.5 max-w-[320px] text-[12.5px] leading-[1.65] text-muted-foreground">
					Add a repository and describe the work. AO runs agents on isolated branches, from start to merge.
				</p>

				<div className="mt-6 w-full overflow-hidden rounded-[12px] border border-border bg-surface text-left">
					<WelcomeStep n="01" title="Add a project">
						Choose a local git repository and select the agents AO should use.
					</WelcomeStep>
					<div className="mx-4 h-px bg-border" />
					<WelcomeStep n="02" title="Describe a task">
						Tell the orchestrator what you want done. It spawns worker sessions on isolated branches.
					</WelcomeStep>
					<div className="mx-4 h-px bg-border" />
					<WelcomeStep n="03" title="Review and merge">
						<span>Track each session as it moves through the board:</span>
						<span className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
							{FLOW.map((stage, i) => (
								<span key={stage.label} className="flex items-center gap-1.5">
									{i > 0 && <span className="text-[10px] text-passive">→</span>}
									<span className="flex items-center gap-1">
										<span
											className="h-[6px] w-[6px] shrink-0 rounded-full"
											style={{ background: stage.color }}
										/>
										<span className="text-[11.5px] text-muted-foreground">{stage.label}</span>
									</span>
								</span>
							))}
						</span>
					</WelcomeStep>
				</div>

				<CreateProjectFlow idleLabel="Add your first project" onCreateProject={createProject}>
					{({ choosePath, disabled, error, label }) => (
						<>
							<button
								aria-label="Add your first project"
								className="dashboard-app-header__primary-btn mt-6"
								disabled={disabled}
								onClick={choosePath}
								type="button"
							>
								<Plus className="h-3.5 w-3.5" aria-hidden="true" />
								{label}
							</button>
							{error && <p className="mt-3 text-[11px] leading-[1.5] text-error">{error}</p>}
						</>
					)}
				</CreateProjectFlow>
				<p className="mt-2.5 text-[11px] text-passive">
					Starts an orchestrator session for the project.
				</p>
			</div>
		</div>
	);
}

function WelcomeStep({ n, title, children }: { n: string; title: string; children: ReactNode }) {
	return (
		<div className="flex gap-4 px-4 py-4">
			<span className="mt-[1px] shrink-0 font-mono text-[10px] font-medium leading-[1.8] text-passive">{n}</span>
			<div className="min-w-0">
				<p className="text-[13px] font-semibold text-foreground">{title}</p>
				<p className="mt-1 text-[12px] leading-[1.6] text-muted-foreground">{children}</p>
			</div>
		</div>
	);
}

// Project board with a registered project but no worker sessions yet: a quiet
// invitation instead of four empty columns. Actions mirror the board header
// (Orchestrator stays the primary, like the topbar) so the vocabulary holds.
export function ProjectBoardEmpty({
	hasOrchestrator,
	isProjectRestarting,
	isSpawning,
	onNewTask,
	onOpenOrchestrator,
	spawnError,
}: {
	hasOrchestrator: boolean;
	isProjectRestarting: boolean;
	isSpawning: boolean;
	onNewTask: () => void;
	onOpenOrchestrator: () => void;
	spawnError?: string | null;
}) {
	return (
		<div className="flex h-full min-h-0 items-center justify-center overflow-y-auto">
			<div className="flex w-full max-w-[400px] flex-col items-center pb-[5vh] text-center">
				<h2 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">No worker sessions yet</h2>
				<p className="mt-2 text-[12.5px] leading-[1.6] text-muted-foreground">
					Describe a task and the orchestrator plans it, spawns worker sessions, and tracks them here from work to
					merge.
				</p>
				<div className="mt-5 flex items-center gap-2">
					<button
						aria-label={hasOrchestrator ? "Orchestrator" : "Spawn Orchestrator"}
						className="dashboard-app-header__primary-btn"
						disabled={isSpawning || isProjectRestarting}
						onClick={onOpenOrchestrator}
						type="button"
					>
						<OrchestratorIcon className="h-3.5 w-3.5" aria-hidden="true" />
						{isProjectRestarting
							? "Restarting..."
							: isSpawning
								? "Spawning..."
								: hasOrchestrator
									? "Orchestrator"
									: "Spawn Orchestrator"}
					</button>
					<button
						aria-label="New task"
						className="dashboard-app-header__accent-btn"
						disabled={isProjectRestarting}
						onClick={onNewTask}
						type="button"
					>
						<Plus className="h-3.5 w-3.5" aria-hidden="true" />
						New task
					</button>
				</div>
				{spawnError && (
					<p className="mt-3 text-[11px] leading-[1.5] text-error" role="status">
						{spawnError}
					</p>
				)}
			</div>
		</div>
	);
}
