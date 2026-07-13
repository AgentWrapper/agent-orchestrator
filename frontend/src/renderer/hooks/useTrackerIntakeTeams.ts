import { useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";

export type TrackerTeam = components["schemas"]["TrackerTeam"];
type TeamsResponse = components["schemas"]["TrackerIntakeTeamsResponse"];

export const trackerIntakeTeamsQueryKey = ["tracker-intake", "linear", "teams"] as const;

async function fetchTeams(): Promise<TeamsResponse> {
	const { data, error } = await apiClient.GET("/api/v1/tracker-intake/linear/teams");
	if (error) throw new Error(apiErrorMessage(error));
	return data as TeamsResponse;
}

export function useTrackerIntakeTeams(enabled: boolean) {
	return useQuery({
		queryKey: trackerIntakeTeamsQueryKey,
		queryFn: fetchTeams,
		enabled,
		staleTime: 5 * 60 * 1000,
		retry: 1,
	});
}
