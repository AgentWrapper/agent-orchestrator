import { createFileRoute } from "@tanstack/react-router";
import { WorkerCapacityPage } from "../components/WorkerCapacityPage";

export const Route = createFileRoute("/_shell/projects/$projectId_/capacity")({
	component: ProjectCapacityRoute,
});

function ProjectCapacityRoute() {
	const { projectId } = Route.useParams();
	return <WorkerCapacityPage projectId={projectId} />;
}
