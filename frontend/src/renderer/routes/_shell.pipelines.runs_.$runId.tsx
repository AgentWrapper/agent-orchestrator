import { createFileRoute } from "@tanstack/react-router";
import { PipelineRunDetail } from "../components/PipelineRunDetail";

// Trailing underscore on `runs_` opts the detail out of the runs workbench
// layout, so it renders as its own full-screen view rather than inside the
// Kanban. `project` scopes the cancel/resume calls (they are project-scoped);
// it is threaded in when navigating from a board card.
export const Route = createFileRoute("/_shell/pipelines/runs_/$runId")({
	validateSearch: (search: Record<string, unknown>): { project?: string } => ({
		project: typeof search.project === "string" ? search.project : undefined,
	}),
	component: RunDetailRoute,
});

function RunDetailRoute() {
	const { runId } = Route.useParams();
	const { project } = Route.useSearch();
	return <PipelineRunDetail runId={runId} project={project} />;
}
