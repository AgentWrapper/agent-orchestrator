import { useState, type ReactNode } from "react";
import { aoBridge } from "../lib/bridge";
import { CreateProjectAgentSheet, type CreateProjectAgentSelection } from "./CreateProjectAgentSheet";

export type CreateProjectInput = { path: string } & CreateProjectAgentSelection;

const SETUP_CONFIRMATION =
	"AO will initialize Git if needed, stage this folder's files, and create the first commit before importing it.";

// Shared create-project flow (native folder picker → agent sheet → create):
// render-prop so the sidebar's + buttons and the board's first-run CTA drive
// the exact same logic instead of duplicating the picker/sheet wiring.
export function CreateProjectFlow({
	children,
	idleLabel = "New project",
	onCreateProject,
	onInitializeProject,
}: {
	children: (state: { choosePath: () => void; disabled: boolean; error: string | null; label: string }) => ReactNode;
	idleLabel?: string;
	onCreateProject: (input: CreateProjectInput) => Promise<void>;
	onInitializeProject: (path: string) => Promise<void>;
}) {
	const [error, setError] = useState<string | null>(null);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [isChoosingPath, setIsChoosingPath] = useState(false);
	const [isCreating, setIsCreating] = useState(false);
	const [isInitializing, setIsInitializing] = useState(false);

	const choosePath = async () => {
		setError(null);
		setIsChoosingPath(true);
		try {
			const path = await aoBridge.app.chooseDirectory();
			if (path) setSelectedPath(path);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not add project");
		} finally {
			setIsChoosingPath(false);
		}
	};

	const createProject = async (selection: CreateProjectAgentSelection) => {
		if (!selectedPath) return;
		setError(null);
		setIsCreating(true);
		try {
			await onCreateProject({ path: selectedPath, ...selection });
			setSelectedPath(null);
		} catch (err) {
			const code = err instanceof Error && "code" in err ? (err.code as string | undefined) : undefined;
			const message = err instanceof Error ? err.message : "Could not add project";
			if (code === "NOT_A_GIT_REPO" || code === "PROJECT_UNBORN") {
				const confirmed = window.confirm(`Set up Git for ${selectedPath}? ${SETUP_CONFIRMATION}`);
				if (!confirmed) {
					setError(message);
					return;
				}
				setIsCreating(false);
				setIsInitializing(true);
				try {
					await onInitializeProject(selectedPath);
				} catch (setupErr) {
					setError(setupErr instanceof Error ? `Setup failed: ${setupErr.message}` : "Setup failed");
					return;
				} finally {
					setIsInitializing(false);
				}

				setIsCreating(true);
				try {
					await onCreateProject({ path: selectedPath, ...selection });
					setSelectedPath(null);
				} catch (retryErr) {
					setError(retryErr instanceof Error ? retryErr.message : "Could not add project");
				}
				return;
			}
			setError(message);
		} finally {
			setIsCreating(false);
		}
	};

	const label = isChoosingPath
		? "Opening..."
		: isInitializing
			? "Setting up..."
			: isCreating
				? "Creating..."
				: idleLabel;

	return (
		<>
			{children({
				choosePath: () => void choosePath(),
				disabled: isChoosingPath || isCreating || isInitializing,
				error,
				label,
			})}
			<CreateProjectAgentSheet
				error={error}
				isCreating={isCreating}
				isInitializing={isInitializing}
				kind="single_repo"
				onOpenChange={(open) => {
					if (!open) {
						setSelectedPath(null);
						setError(null);
					}
				}}
				onSubmit={createProject}
				open={selectedPath !== null}
				path={selectedPath}
			/>
			{error && (
				<span className="sr-only" role="status">
					{error}
				</span>
			)}
		</>
	);
}
