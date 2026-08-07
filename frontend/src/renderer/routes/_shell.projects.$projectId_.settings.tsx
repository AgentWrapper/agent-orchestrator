import { createFileRoute, useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useUiStore } from "../stores/ui-store";

export const Route = createFileRoute("/_shell/projects/$projectId_/settings")({
	component: ProjectSettingsRoute,
});

// Deep-link shim: project settings is a modal. Prefer returning to the previous
// page so opening settings from a session does not jump to the project board.
function ProjectSettingsRoute() {
	const { projectId } = Route.useParams();
	const navigate = useNavigate();
	const router = useRouter();
	const canGoBack = useCanGoBack();
	const openProjectSettings = useUiStore((state) => state.openProjectSettings);
	const didOpen = useRef(false);

	useEffect(() => {
		if (didOpen.current) return;
		didOpen.current = true;
		openProjectSettings(projectId);
		if (canGoBack) {
			router.history.back();
		} else {
			void navigate({ to: "/projects/$projectId", params: { projectId }, replace: true });
		}
	}, [canGoBack, navigate, openProjectSettings, projectId, router]);

	return null;
}
