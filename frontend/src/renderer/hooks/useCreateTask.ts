import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { captureRendererEvent } from "../lib/telemetry";
import type { components } from "../../api/schema";
import type { ImageAttachmentPayload } from "./useImageAttachments";
import { agentsQueryKey } from "./useAgentsQuery";

type SpawnHarness = components["schemas"]["SpawnSessionRequest"]["harness"];

export type CreateTaskInput = {
	projectId: string;
	title: string;
	prompt: string;
	branch?: string;
	harness?: SpawnHarness;
	attachments?: ImageAttachmentPayload[];
};

export function useCreateTask(): (input: CreateTaskInput) => Promise<string> {
	const queryClient = useQueryClient();
	const { t } = useTranslation();

	return useCallback(
		async (input: CreateTaskInput) => {
			void captureRendererEvent("ao.renderer.task_create_requested", { project_id: input.projectId });
			try {
				const { data, error } = await apiClient.POST("/api/v1/sessions", {
					body: {
						projectId: input.projectId,
						kind: "worker",
						harness: input.harness,
						issueId: input.title,
						prompt: input.prompt,
						...(input.branch ? { branch: input.branch } : {}),
						attachments: input.attachments && input.attachments.length > 0 ? input.attachments : undefined,
					},
				});
				if (error) throw new Error(apiErrorMessage(error, t("newTask.unableToStart")));
				if (!data?.session?.id) throw new Error(t("newTask.noSession"));
				void captureRendererEvent("ao.renderer.task_create_succeeded", { project_id: input.projectId });
				return data.session.id;
			} catch (err) {
				void captureRendererEvent("ao.renderer.task_create_failed", { project_id: input.projectId });
				void queryClient.invalidateQueries({ queryKey: agentsQueryKey });
				throw err instanceof Error ? err : new Error(t("newTask.unableToStart"));
			}
		},
		[queryClient, t],
	);
}
