import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import type { WorkspaceSession } from "../types/workspace";
import { agentSwitchesQueryKey } from "./useAgentSwitches";
import { workspaceQueryKey } from "./useWorkspaceQuery";

export type SwitchAgentHarness = components["schemas"]["SwitchAgentRequest"]["targetHarness"];

export type SwitchAgentInput = {
	session: WorkspaceSession;
	targetHarness: SwitchAgentHarness;
	note: string;
	idempotencyKey: string;
};

export function createSwitchAgentIdempotencyKey(): string {
	return crypto.randomUUID();
}

export function useSwitchAgent() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: ["switch-agent"],
		mutationFn: async ({ session, targetHarness, note, idempotencyKey }: SwitchAgentInput) => {
			const body: {
				targetHarness: SwitchAgentHarness;
				note?: string;
				idempotencyKey: string;
			} = { targetHarness, idempotencyKey };
			const normalizedNote = note.trim();
			if (normalizedNote) body.note = normalizedNote;

			const { data, error, response } = await apiClient.POST(
				"/api/v1/sessions/{sessionId}/switch-agent",
				{
					params: { path: { sessionId: session.id } },
					body,
				},
			);
			if (error) {
				const fallback = response
					? `Failed to switch agent (${response.status})`
					: "Failed to switch agent";
				throw new Error(apiErrorMessage(error, fallback));
			}
			return data?.switch;
		},
		// A post-stop failure can legitimately leave the selected target as the
		// current (exited or delivery-unconfirmed) owner. Always refresh the
		// session projection, even when the mutation surfaces an error.
		onSettled: async (_data, _error, variables) => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: workspaceQueryKey }),
				queryClient.invalidateQueries({ queryKey: agentSwitchesQueryKey(variables.session.id) }),
			]);
		},
	});
}
