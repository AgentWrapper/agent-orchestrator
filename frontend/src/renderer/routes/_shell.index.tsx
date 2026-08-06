import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { MigrationPopup } from "../components/MigrationPopup";
import { SessionsBoard } from "../components/SessionsBoard";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";

export const Route = createFileRoute("/_shell/")({
	component: ShellIndex,
});

function ShellIndex() {
	const navigate = useNavigate();
	const workspaceQuery = useWorkspaceQuery();

	useEffect(() => {
		if (!workspaceQuery.isSuccess) return;
		const workspaces = workspaceQuery.data ?? [];
		const projects = workspaces.filter((workspace) => workspace.kind !== "scratch");
		const workspace =
			projects.length === 1
				? projects[0]
				: projects.length === 0 && workspaces.length === 1 && workspaces[0]?.kind === "scratch"
					? workspaces[0]
					: undefined;
		if (!workspace) return;
		void navigate({
			to: "/projects/$projectId",
			params: { projectId: workspace.id },
			replace: true,
		});
	}, [navigate, workspaceQuery.data, workspaceQuery.isSuccess]);

	return (
		<>
			<MigrationPopup />
			<SessionsBoard />
		</>
	);
}
