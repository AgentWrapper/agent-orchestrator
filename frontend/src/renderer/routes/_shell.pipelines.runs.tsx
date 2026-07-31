import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { PipelineWorkbench } from "../components/PipelineWorkbench";

// The project lives on the parent section route's `project` search param, the
// same as the Definitions tab; the runs list itself spans every project, but the
// pipeline rail lists the selected project's definitions.
const sectionRoute = getRouteApi("/_shell/pipelines");

export const Route = createFileRoute("/_shell/pipelines/runs")({
	component: PipelinesRunsRoute,
});

function PipelinesRunsRoute() {
	const { project } = sectionRoute.useSearch();
	return <PipelineWorkbench projectId={project} />;
}
