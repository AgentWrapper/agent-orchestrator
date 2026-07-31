import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { PipelineDefinitionsPage } from "../components/PipelineDefinitionsPage";

// The project lives on the parent section route's `project` search param; read it
// there so the picker in the section shell drives this tab.
const sectionRoute = getRouteApi("/_shell/pipelines");

export const Route = createFileRoute("/_shell/pipelines/")({
	component: PipelinesDefinitionsRoute,
});

function PipelinesDefinitionsRoute() {
	const { project } = sectionRoute.useSearch();
	return <PipelineDefinitionsPage projectId={project} />;
}
