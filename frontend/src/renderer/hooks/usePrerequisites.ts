import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../lib/api-client";

export const prerequisitesQueryKey = ["prerequisites"] as const;
const usePreviewData = import.meta.env.VITE_NO_ELECTRON === "1";

export interface PrerequisiteStatus {
	name: string;
	satisfied: boolean;
	/** The exact line that installs it, ready to show or copy. */
	installCommand?: string;
	/** Whether the app can run installCommand itself (no password prompt). */
	installable: boolean;
}

// A daemon that cannot answer resolves to "satisfied" rather than an error: a
// board-wide warning is worth showing when we KNOW tmux is missing, and worth
// staying quiet about when we simply could not ask.
async function fetchPrerequisites(): Promise<{ tmux: PrerequisiteStatus }> {
	const { data, error } = await apiClient.GET("/api/v1/prerequisites");
	if (error || !data) return { tmux: { name: "tmux", satisfied: true, installable: false } };
	return data as { tmux: PrerequisiteStatus };
}

export function usePrerequisites() {
	return useQuery({
		queryKey: prerequisitesQueryKey,
		queryFn: fetchPrerequisites,
		enabled: !usePreviewData,
		retry: 1,
		throwOnError: false,
	});
}
