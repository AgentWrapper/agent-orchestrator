import { createFileRoute } from "@tanstack/react-router";
import { SessionView } from "../components/SessionView";

export const Route = createFileRoute("/_shell/projects/$projectId_/sessions/$sessionId")({
	component: ProjectSessionRoute,
});

function ProjectSessionRoute() {
	const { sessionId } = Route.useParams();
	return <SessionView sessionId={sessionId} />;
}
