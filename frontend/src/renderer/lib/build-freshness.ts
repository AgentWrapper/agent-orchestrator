import { useQuery } from "@tanstack/react-query";

type WebBuildManifest = {
	frontendTree?: string;
};

export type BuildFreshness =
	| { state: "current"; clientFrontendTree: string; servedFrontendTree?: string }
	| { state: "stale"; clientFrontendTree: string; servedFrontendTree: string }
	| { state: "unknown"; clientFrontendTree: string; reason: string };

export const CLIENT_FRONTEND_TREE = __AO_RENDERER_FRONTEND_TREE__.trim();

const CHECK_INTERVAL_MS = 60_000;

function comparableIdentity(value: string | undefined): string {
	return value?.trim() ?? "";
}

export function classifyBuildFreshness(
	clientFrontendTree: string,
	manifest: WebBuildManifest | undefined,
): BuildFreshness {
	const client = comparableIdentity(clientFrontendTree);
	if (client === "") {
		return { state: "unknown", clientFrontendTree: client, reason: "client frontend tree unavailable" };
	}
	const servedFrontendTree = comparableIdentity(manifest?.frontendTree);
	if (servedFrontendTree === "") {
		return { state: "unknown", clientFrontendTree: client, reason: "served frontend tree unavailable" };
	}
	if (servedFrontendTree !== client) {
		return {
			state: "stale",
			clientFrontendTree: client,
			servedFrontendTree,
		};
	}
	return { state: "current", clientFrontendTree: client, servedFrontendTree };
}

export const buildFreshnessQueryKey = ["build-freshness"] as const;

export function useBuildFreshness() {
	return useQuery({
		queryKey: buildFreshnessQueryKey,
		queryFn: async () => {
			const response = await fetch(`/ao-web-build.json?ts=${Date.now()}`, { cache: "no-store" });
			// Missing manifests from old web releases fail open as query errors; only a
			// confirmed tree mismatch is allowed to block settings writes.
			if (!response.ok) throw new Error("Could not load AO web build manifest.");
			const manifest = (await response.json()) as WebBuildManifest;
			return classifyBuildFreshness(CLIENT_FRONTEND_TREE, manifest);
		},
		refetchInterval: CHECK_INTERVAL_MS,
		retry: false,
	});
}
