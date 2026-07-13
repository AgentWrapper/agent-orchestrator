import { useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";

export type TrackerIntakeIdentity = components["schemas"]["TrackerIntakeIdentityResponse"];

export const trackerIntakeIdentityQueryKey = ["tracker-intake", "github", "user"] as const;

async function fetchTrackerIntakeIdentity(): Promise<TrackerIntakeIdentity> {
	const { data, error } = await apiClient.GET("/api/v1/tracker-intake/github/user");
	if (error) throw new Error(apiErrorMessage(error));
	return data as TrackerIntakeIdentity;
}

export const trackerIntakeIdentityQueryOptions = {
	queryKey: trackerIntakeIdentityQueryKey,
	queryFn: fetchTrackerIntakeIdentity,
	retry: 1,
	staleTime: Number.POSITIVE_INFINITY,
};

export function useTrackerIntakeIdentity(enabled: boolean) {
	return useQuery({ ...trackerIntakeIdentityQueryOptions, enabled });
}
