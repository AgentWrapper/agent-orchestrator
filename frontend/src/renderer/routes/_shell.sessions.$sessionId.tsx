import { createFileRoute } from "@tanstack/react-router";
import { SessionView } from "../components/SessionView";

export const Route = createFileRoute("/_shell/sessions/$sessionId")({
	component: SessionRoute,
});

function SessionRoute() {
	const { sessionId } = Route.useParams();
	return <SessionView sessionId={sessionId} />;
}
