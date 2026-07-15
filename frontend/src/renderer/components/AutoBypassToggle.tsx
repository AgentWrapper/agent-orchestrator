import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldCheck } from "lucide-react";
import type { CSSProperties } from "react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { cn } from "../lib/utils";
import { TopbarButton } from "./TopbarButton";

type Project = components["schemas"]["Project"];
type ProjectConfig = components["schemas"]["ProjectConfig"];

export const projectDetailQueryKey = (projectId: string) => ["project", projectId] as const;

export function AutoBypassToggle({
	disabled = false,
	projectId,
	style,
}: {
	disabled?: boolean;
	projectId: string;
	style?: CSSProperties;
}) {
	const queryClient = useQueryClient();
	const projectQuery = useQuery({
		queryKey: projectDetailQueryKey(projectId),
		queryFn: async () => {
			const { data, error } = await apiClient.GET("/api/v1/projects/{id}", {
				params: { path: { id: projectId } },
			});
			if (error) throw new Error(apiErrorMessage(error, "Unable to load worker permission policy"));
			if (data?.status !== "ok") throw new Error("Project config is unavailable.");
			return data.project as Project;
		},
		staleTime: 10_000,
	});
	const enabled = projectQuery.data?.config?.autoBypassWorkerPermissions ?? false;
	const mutation = useMutation({
		mutationFn: async (nextEnabled: boolean) => {
			const project = projectQuery.data;
			if (!project) throw new Error("Project config is still loading.");
			const nextConfig: ProjectConfig = {
				...(project.config ?? {}),
				autoBypassWorkerPermissions: nextEnabled,
			};
			const { error } = await apiClient.PUT("/api/v1/projects/{id}/config", {
				params: { path: { id: projectId } },
				body: { config: nextConfig },
			});
			if (error) throw new Error(apiErrorMessage(error, "Unable to update worker permissions"));
			return { nextConfig, project };
		},
		onSuccess: ({ nextConfig, project }) => {
			queryClient.setQueryData(projectDetailQueryKey(projectId), { ...project, config: nextConfig });
		},
	});
	const error = projectQuery.error ?? mutation.error;
	const title =
		error instanceof Error
			? error.message
			: enabled
				? "All subagents have complete access"
				: "Subagents use project and task permission settings";

	return (
		<>
			<TopbarButton
				aria-label="Toggle bypass permission mode for all subagents"
				aria-pressed={enabled}
				className={cn(enabled && "border-warning/60 bg-warning/10 text-foreground")}
				disabled={disabled || projectQuery.isLoading || projectQuery.isError || mutation.isPending}
				onClick={() => mutation.mutate(!enabled)}
				style={style}
				title={title}
				variant="accent"
			>
				{mutation.isPending ? (
					<Loader2 className="size-icon-md animate-spin" aria-hidden="true" />
				) : (
					<ShieldCheck className="size-icon-md" aria-hidden="true" />
				)}
				Full access
			</TopbarButton>
			{mutation.isError && (
				<span className="sr-only" role="alert">
					{title}
				</span>
			)}
		</>
	);
}
