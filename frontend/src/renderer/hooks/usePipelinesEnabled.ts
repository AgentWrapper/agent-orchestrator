import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../lib/api-client";

export const pipelinesEnabledQueryKey = ["pipelines-enabled"] as const;

// Capability probe for the backend AO_PIPELINES feature flag. There is no
// dedicated capabilities endpoint: when the flag is off, the pipelines
// Manager is nil and every /api/v1/pipelines/* route (including this static
// schema route) returns 501. When the flag is on, this route returns 200
// with a JSON body. We read the raw response status rather than the parsed
// body, since we only care whether the route exists, not its contents.
async function fetchPipelinesEnabled(): Promise<boolean> {
	try {
		const { response } = await apiClient.GET("/api/v1/pipelines/schema", {});
		return response.status === 200;
	} catch {
		// Network failure or similar: fall through to the safe (hidden) default
		// below instead of leaving the query in a permanent error state.
		return false;
	}
}

// The flag is fixed for a daemon's lifetime, so one probe per app session is
// enough: cache forever and never retry. Any failure (network error, non-200
// and non-501 status) resolves to `false`, the safe default that hides the
// feature rather than risk showing a broken section.
export function usePipelinesEnabled() {
	const query = useQuery({
		queryKey: pipelinesEnabledQueryKey,
		queryFn: fetchPipelinesEnabled,
		staleTime: Infinity,
		gcTime: Infinity,
		retry: false,
	});

	return { enabled: query.data, isLoading: query.isLoading };
}
