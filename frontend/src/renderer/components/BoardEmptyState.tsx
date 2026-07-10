import { Fragment, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { useShell } from "../lib/shell-context";
import { cn } from "../lib/utils";
import aoLogo from "../assets/ao-logo.png";
import { CreateProjectFlow } from "./CreateProjectFlow";
import { OrchestratorIcon } from "./icons";

// The four board zones, in flow order — mirrors COLUMNS in SessionsBoard.tsx
// (label + dot color + title tint) so the welcome legend pre-teaches exactly
// what the user will see once the board has sessions.
const FLOW_LEGEND = [
	{ label: "Working", dot: "var(--orange)", titleClass: "text-working" },
	{ label: "Needs you", dot: "var(--amber)", titleClass: "text-warning" },
	{ label: "In review", dot: "var(--fg-muted)", titleClass: "text-muted-foreground" },
	{ label: "Ready to merge", dot: "var(--green)", titleClass: "text-success" },
];

// First-launch board state (no projects registered yet): replaces the four
// empty kanban columns with orientation — what this app does, the three steps
// to a first merge, and the same create-project flow the sidebar's + runs.
export function BoardWelcome() {
	const { createProject } = useShell();
	return (
		<div className="flex h-full min-h-0 items-center justify-center overflow-y-auto">
			<div className="flex w-full max-w-[460px] flex-col items-center pb-[5vh] text-center">
				<img src={aoLogo} alt="" aria-hidden="true" className="h-10 w-10 rounded-[10px] object-cover" />
				<h2 className="mt-5 text-[17px] font-semibold tracking-[-0.015em] text-foreground">
					Welcome to Agent Orchestrator
				</h2>
				<p className="mt-2 max-w-[400px] text-[12.5px] leading-[1.6] text-muted-foreground">
					Add a git repository, describe the work, and AO coordinates agent sessions on isolated branches. This kanban
					board tracks each session from work through review to merge.
				</p>

				<ol className="mt-7 w-full divide-y divide-border rounded-[13px] border border-border bg-surface text-left">
					<WelcomeStep n="01" title="Add a project">
						Choose a local git repository and select the agents AO should use.
					</WelcomeStep>
					<WelcomeStep n="02" title="Describe a task">
						Tell the orchestrator what you want done; it creates worker sessions on isolated branches.
					</WelcomeStep>
					<WelcomeStep n="03" title="Review and merge">
						Follow each session from work to review to merge readiness:
						<span className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
							{FLOW_LEGEND.map((zone, index) => (
								<Fragment key={zone.label}>
									{index > 0 && (
										<span aria-hidden="true" className="text-[10px] text-passive">
											→
										</span>
									)}
									<span
										className={cn(
											"inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em]",
											zone.titleClass,
										)}
									>
										<span className="h-[7px] w-[7px] rounded-full" style={{ background: zone.dot }} />
										{zone.label}
									</span>
								</Fragment>
							))}
						</span>
					</WelcomeStep>
				</ol>

				<CreateProjectFlow idleLabel="Add your first project" onCreateProject={createProject}>
					{({ choosePath, disabled, error, label }) => (
						<>
							<button
								aria-label="Add your first project"
								className="dashboard-app-header__primary-btn mt-7"
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
				<p className="mt-3 text-[11px] text-passive">
					Adding a project starts its orchestrator — the agent you talk to.
				</p>
			</div>
		</div>
	);
}

function WelcomeStep({ n, title, children }: { n: string; title: string; children: ReactNode }) {
	return (
		<li className="flex gap-3.5 px-4 py-3.5">
			<span className="pt-px font-mono text-[10.5px] font-medium leading-[1.7] text-passive">{n}</span>
			<span className="min-w-0 flex-1">
				<span className="block text-[13px] font-medium text-foreground">{title}</span>
				<span className="mt-1 block text-[12px] leading-[1.55] text-muted-foreground">{children}</span>
			</span>
		</li>
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
