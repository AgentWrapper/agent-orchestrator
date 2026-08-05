import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

export function useNavigateToSession(): (projectId: string | undefined, sessionId: string) => void {
	const navigate = useNavigate();
	return useCallback(
		(projectId: string | undefined, sessionId: string) => {
			if (!sessionId) return;
			if (projectId) {
				void navigate({
					to: "/projects/$projectId/sessions/$sessionId",
					params: { projectId, sessionId },
				});
				return;
			}
			void navigate({ to: "/sessions/$sessionId", params: { sessionId } });
		},
		[navigate],
	);
}
