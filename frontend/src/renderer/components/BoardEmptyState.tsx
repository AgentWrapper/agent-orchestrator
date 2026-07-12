import { Plus } from "lucide-react";
import { useShell } from "../lib/shell-context";
import aoLogo from "../assets/ao-logo.png";
import { CreateProjectFlow } from "./CreateProjectFlow";
import { TopbarButton } from "./TopbarButton";
import { OrchestratorIcon } from "./icons";

// First-launch board state (no projects registered yet): replaces the four
// empty kanban columns with orientation and the same create-project flow the
// sidebar's + runs.
export function BoardWelcome() {
	const { createProject, initializeProjectRepository } = useShell();
	return (
		<div className="flex h-full min-h-0 items-center justify-center overflow-y-auto">
			<div className="flex w-full max-w-board-empty flex-col items-center pb-empty-offset-y text-center">
				<img src={aoLogo} alt="" aria-hidden="true" className="size-10 rounded-lg object-cover" />
				<h2 className="mt-5 text-heading-sm font-semibold tracking-tight-lg text-foreground">
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
							<TopbarButton
								aria-label="Add your first project"
								className="mt-7"
								disabled={disabled}
								onClick={choosePath}
								variant="primary"
							>
								<Plus className="size-icon-md" aria-hidden="true" />
								{label}
							</TopbarButton>
							{error && <p className="mt-3 text-caption leading-body text-error">{error}</p>}
						</>
					)}
				</CreateProjectFlow>
				<p className="mt-3 text-caption text-passive">
					Adding a project starts its orchestrator — the agent you talk to.
				</p>
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
			<div className="flex w-full max-w-preview-content flex-col items-center pb-empty-offset-y text-center">
				<h2 className="text-subtitle font-semibold tracking-tight text-foreground">No worker sessions yet</h2>
				<p className="mt-2 text-md-sm leading-relaxed text-muted-foreground">
					Describe a task and the orchestrator plans it, spawns worker sessions, and tracks them here from work to
					merge.
				</p>
				<div className="mt-5 flex items-center gap-2">
					<TopbarButton
						aria-label={hasOrchestrator ? "Orchestrator" : "Spawn Orchestrator"}
						disabled={isSpawning || isProjectRestarting}
						onClick={onOpenOrchestrator}
						variant="primary"
					>
						<OrchestratorIcon className="size-icon-md" aria-hidden="true" />
						{isProjectRestarting
							? "Restarting..."
							: isSpawning
								? "Spawning..."
								: hasOrchestrator
									? "Orchestrator"
									: "Spawn Orchestrator"}
					</TopbarButton>
					<TopbarButton aria-label="New task" disabled={isProjectRestarting} onClick={onNewTask} variant="accent">
						<Plus className="size-icon-md" aria-hidden="true" />
						New task
					</TopbarButton>
				</div>
				{spawnError && (
					<p className="mt-3 text-caption leading-body text-error" role="status">
						{spawnError}
					</p>
				)}
			</div>
		</div>
	);
}
