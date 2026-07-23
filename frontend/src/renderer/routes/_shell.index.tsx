import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { SessionsBoard } from "../components/SessionsBoard";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";

export const Route = createFileRoute("/_shell/")({
	component: ShellIndex,
});

// MigrationPopup lives on the parent shell layout so the first-run scratch
// redirect below does not unmount the legacy-import offer.
function ShellIndex() {
	const navigate = useNavigate();
	const workspaceQuery = useWorkspaceQuery();

	useEffect(() => {
		if (!workspaceQuery.isSuccess) return;
		const workspaces = workspaceQuery.data ?? [];
		if (workspaces.length !== 1) return;
		const [workspace] = workspaces;
		if (workspace.id !== "scratch" || workspace.kind !== "scratch") return;
		void navigate({
			to: "/projects/$projectId",
			params: { projectId: "scratch" },
			replace: true,
		});
	}, [navigate, workspaceQuery.data, workspaceQuery.isSuccess]);

	return <SessionsBoard />;
}
