import { Plus } from "lucide-react";

import { useShell } from "../lib/shell-context";
import aoLogo from "../assets/ao-logo.png";
import { CreateProjectFlow } from "./CreateProjectFlow";
import { OrchestratorIcon } from "./icons";

export function BoardWelcome() {
	const { createProject, initializeProjectRepository } = useShell();
	return (
		<div className="flex h-full min-h-0 items-center justify-center overflow-y-auto">
			<div className="flex w-full max-w-[460px] flex-col items-center pb-[6vh] text-center">
				<img src={aoLogo} alt="" aria-hidden="true" className="h-20 w-20 rounded-[16px] object-cover" />
				<h2 className="mt-5 text-[15px] font-semibold tracking-[-0.01em] text-foreground">
					Welcome to Agent Orchestrator
				</h2>
				<p className="mt-1.5 max-w-[320px] text-[12.5px] leading-[1.65] text-muted-foreground">
					Add a repository and describe the work. AO runs agents on isolated branches, from start to merge.
				</p>

				<CreateProjectFlow
					idleLabel="Add your first project"
					onCreateProject={createProject}
					onInitializeProject={initializeProjectRepository}
				>
					{({ choosePath, disabled, error, label }) => (
						<>
							<button
								aria-label="Add your first project"
								className="mt-7 inline-flex h-8 items-center rounded-md border border-border px-4 text-[13px] font-medium text-foreground transition-colors hover:bg-surface disabled:pointer-events-none disabled:opacity-50"
								disabled={disabled}
								onClick={choosePath}
								type="button"
							>
								{label}
							</button>
							{error && <p className="mt-3 text-[11px] leading-[1.5] text-error">{error}</p>}
						</>
					)}
				</CreateProjectFlow>
				<p className="mt-2.5 text-[11px] text-passive">Starts an orchestrator session for the project.</p>
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
