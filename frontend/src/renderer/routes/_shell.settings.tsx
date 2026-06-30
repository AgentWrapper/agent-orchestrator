import { createFileRoute } from "@tanstack/react-router";
import { GlobalSettingsForm } from "../components/GlobalSettingsForm";

export const Route = createFileRoute("/_shell/settings")({
	component: GlobalSettingsForm,
});
