import { createFileRoute } from "@tanstack/react-router";
import { ShellTerminalsView } from "../components/ShellTerminalsView";

export const Route = createFileRoute("/_shell/terminals")({
	component: ShellTerminalsView,
});
