import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SuggestionsPage } from "../components/SuggestionsPage";

export const Route = createFileRoute("/_shell/projects/$projectId_/suggestions")({
	component: ProjectSuggestionsRoute,
});

function ProjectSuggestionsRoute() {
	const { projectId } = Route.useParams();
	const navigate = useNavigate();
	return (
		<SuggestionsPage
			key={projectId}
			projectId={projectId}
			onSessionStarted={(sessionId) =>
				void navigate({
					to: "/projects/$projectId/sessions/$sessionId",
					params: { projectId, sessionId },
				})
			}
		/>
	);
}
