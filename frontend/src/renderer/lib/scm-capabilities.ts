import type { QueryClient } from "@tanstack/react-query";

export type SCMCapabilities = {
	read: boolean;
	write: boolean;
};

const SCM_CAPABILITIES_KEY = "scm-capabilities";

export const scmCapabilitiesQueryKey = (connectionId: string, repository: string) =>
	[SCM_CAPABILITIES_KEY, connectionId, repository.trim()] as const;

export function scmCapabilitiesQueryOptions(connectionId: string, repository: string) {
	return {
		queryKey: scmCapabilitiesQueryKey(connectionId, repository),
		queryFn: async (): Promise<SCMCapabilities | undefined> => undefined,
		enabled: false,
		staleTime: Number.POSITIVE_INFINITY,
	};
}

export function clearSCMCapabilities(queryClient: QueryClient, connectionId: string): void {
	queryClient.removeQueries({
		predicate: (query) => query.queryKey[0] === SCM_CAPABILITIES_KEY && query.queryKey[1] === connectionId,
	});
}
