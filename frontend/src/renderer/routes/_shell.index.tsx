import { createFileRoute } from "@tanstack/react-router";
import { MigrationPopup } from "../components/MigrationPopup";
import { SessionsBoard } from "../components/SessionsBoard";

export const Route = createFileRoute("/_shell/")({
	component: () => (
		<>
			<MigrationPopup />
			<SessionsBoard />
		</>
	),
});
