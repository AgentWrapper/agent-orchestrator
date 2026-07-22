import { createFileRoute } from "@tanstack/react-router";
import { PipelineWorkbench } from "../components/PipelineWorkbench";

export const Route = createFileRoute("/_shell/pipelines/runs")({
	component: PipelineWorkbench,
});
