import * as Dialog from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { Button } from "./ui/button";

type RelaunchSessionsDialogProps = {
	open: boolean;
	projectId: string;
	onOpenChange: (open: boolean) => void;
	onDone?: () => void;
};

export function RelaunchSessionsDialog({ open, projectId, onOpenChange, onDone }: RelaunchSessionsDialogProps) {
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [result, setResult] = useState<{ relaunched: number; failed: number; failedIds: string[] } | undefined>();

	const affectedQuery = useQuery({
		queryKey: ["permission-relaunch-affected", projectId],
		queryFn: async () => {
			const { data, error: apiErr } = await apiClient.GET("/api/v1/projects/{id}/permission-relaunch/affected", {
				params: { path: { id: projectId } },
			});
			if (apiErr) throw new Error(apiErrorMessage(apiErr));
			return data!;
		},
		enabled: open,
	});

	// Auto-dismiss when loaded and nothing affected
	useEffect(() => {
		if (affectedQuery.data && affectedQuery.data.count === 0) {
			onOpenChange(false);
		}
	}, [affectedQuery.data, onOpenChange]);

	const relaunch = async () => {
		setBusy(true);
		setError(undefined);
		try {
			const { data, error: apiErr } = await apiClient.POST("/api/v1/projects/{id}/permission-relaunch", {
				params: { path: { id: projectId } },
			});
			if (apiErr) throw new Error(apiErrorMessage(apiErr));
			const failedIds = (data!.results ?? []).filter((r) => !r.ok).map((r) => r.sessionId);
			setResult({ relaunched: data!.relaunched, failed: data!.failed, failedIds });
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			onDone?.();
			if (data!.failed === 0) {
				onOpenChange(false);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Relaunch failed");
		} finally {
			setBusy(false);
		}
	};

	const count = affectedQuery.data?.count ?? 0;
	const affected = affectedQuery.data?.affected ?? [];
	const plural = count === 1 ? "" : "s";

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5 shadow-lg">
					<Dialog.Title className="text-sm font-medium text-foreground">
						Relaunch sessions with the new permission mode?
					</Dialog.Title>
					{affectedQuery.isLoading && (
						<div className="mt-4 flex justify-center">
							<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
						</div>
					)}
					{affectedQuery.isError && (
						<div className="mt-3 text-[12px] text-destructive">
							{affectedQuery.error instanceof Error ? affectedQuery.error.message : "Failed to load affected sessions"}
						</div>
					)}
					{affectedQuery.data && count > 0 && !result && (
						<>
							<Dialog.Description className="mt-2 text-[13px] text-muted-foreground">
								This restarts each agent in place. Your branch and uncommitted work are kept and the conversation resumes.
								Any in-progress agent turn is interrupted. The orchestrator is not affected.
							</Dialog.Description>
							<ul className="mt-3 flex flex-col gap-1">
								{affected.map((item) => (
									<li key={item.sessionId} className="text-[12px] text-muted-foreground">
										<span className="font-medium text-foreground">{item.title}</span>
										{" "}
										<span className="text-passive">
											{item.fromMode || "default"} {"->"} {item.toMode || "default"}
										</span>
									</li>
								))}
							</ul>
						</>
					)}
					{result && (
						<div className="mt-3 flex flex-col gap-1">
							<p className="text-[13px] text-muted-foreground">
								Relaunched {result.relaunched}, failed {result.failed}.
							</p>
							{result.failed > 0 && result.failedIds.length > 0 && (
								<p className="text-[12px] text-destructive">
									Failed sessions: {result.failedIds.join(", ")}
								</p>
							)}
						</div>
					)}
					{error && <div className="mt-3 text-[12px] text-destructive">{error}</div>}
					<div className="mt-4 flex justify-end gap-2">
						<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
							{result ? "Close" : "Cancel"}
						</Button>
						{!result && count > 0 && (
							<Button onClick={relaunch} disabled={busy || affectedQuery.isLoading}>
								{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
								Relaunch {count} session{plural}
							</Button>
						)}
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
