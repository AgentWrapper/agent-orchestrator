import { useState, type ReactNode } from "react";
import { aoBridge } from "../lib/bridge";
import { CreateProjectAgentSheet, type CreateProjectAgentSelection } from "./CreateProjectAgentSheet";

export type CreateProjectInput = { path: string } & CreateProjectAgentSelection;

// Shared create-project flow (native folder picker → agent sheet → create):
// render-prop so the sidebar's + buttons and the board's first-run CTA drive
// the exact same logic instead of duplicating the picker/sheet wiring.
export function CreateProjectFlow({
	children,
	idleLabel = "New project",
	onCreateProject,
}: {
	children: (state: { choosePath: () => void; disabled: boolean; error: string | null; label: string }) => ReactNode;
	idleLabel?: string;
	onCreateProject: (input: CreateProjectInput) => Promise<void>;
}) {
	const [error, setError] = useState<string | null>(null);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [isChoosingPath, setIsChoosingPath] = useState(false);
	const [isCreating, setIsCreating] = useState(false);

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
			setError(err instanceof Error ? err.message : "Could not add project");
		} finally {
			setIsCreating(false);
		}
	};

	const label = isChoosingPath ? "Opening..." : isCreating ? "Creating..." : idleLabel;

	return (
		<>
			{children({ choosePath: () => void choosePath(), disabled: isChoosingPath || isCreating, error, label })}
			<CreateProjectAgentSheet
				error={error}
				isCreating={isCreating}
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
