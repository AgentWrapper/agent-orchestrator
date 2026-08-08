import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useUiStore } from "../stores/ui-store";

export const Route = createFileRoute("/_shell/projects/$projectId_/settings")({
	component: ProjectSettingsRoute,
});

// Deep-link shim: project settings is a modal. In-app openers call
// openProjectSettings() directly; this route only handles cold loads.
function ProjectSettingsRoute() {
	const { projectId } = Route.useParams();
	const navigate = useNavigate();
	const openProjectSettings = useUiStore((state) => state.openProjectSettings);

	useEffect(() => {
		openProjectSettings(projectId);
		void navigate({ to: "/projects/$projectId", params: { projectId }, replace: true });
	}, [navigate, openProjectSettings, projectId]);

	return null;
}
