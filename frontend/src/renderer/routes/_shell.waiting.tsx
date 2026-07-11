import { createFileRoute } from "@tanstack/react-router";
import { OperatorAttentionPage } from "../components/OperatorAttentionPage";

export const Route = createFileRoute("/_shell/waiting")({
	component: OperatorAttentionPage,
});
