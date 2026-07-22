import { Plus } from "lucide-react";
import { useShell } from "../lib/shell-context";
import { CreateProjectFlow } from "./CreateProjectFlow";
import { TopbarButton } from "./TopbarButton";
import { WelcomePanel } from "./WelcomePanel";
import { OrchestratorIcon } from "./icons";

// Board empty states: first-launch welcome (`BoardWelcome`) and project board
// with no worker sessions yet (`ProjectBoardEmpty`).
export function BoardWelcome() {
	const { createProject, initializeProjectRepository } = useShell();
	return (
		<WelcomePanel>
			<div
				className="flex h-full min-h-0 items-center justify-center overflow-y-auto px-6 py-8"
				data-testid="board-welcome"
			>
				<CreateProjectFlow
					embedded
					mode="choose"
					onCreateProject={createProject}
					onInitializeProject={initializeProjectRepository}
				/>
			</div>
		</WelcomePanel>
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
