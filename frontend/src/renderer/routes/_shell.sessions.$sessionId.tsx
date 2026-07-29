import { createFileRoute } from "@tanstack/react-router";
import { SessionView } from "../components/SessionView";

type SessionSearch = { tabOwner?: string };

export const Route = createFileRoute("/_shell/sessions/$sessionId")({
	validateSearch: (search: Record<string, unknown>): SessionSearch =>
		typeof search.tabOwner === "string" ? { tabOwner: search.tabOwner } : {},
	component: SessionRoute,
});

function SessionRoute() {
	const { sessionId } = Route.useParams();
	const { tabOwner } = Route.useSearch();
	return <SessionView sessionId={sessionId} tabOwnerSessionId={tabOwner} />;
}
