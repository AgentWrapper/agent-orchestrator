import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { cloudCapabilities } from "../lib/cloud-sessions";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { useUiStore } from "../stores/ui-store";
import { newestActiveOrchestrator } from "../types/workspace";
import { OrchestratorLaunchDialog } from "./OrchestratorLaunchDialog";

// App-level orchestrator launcher. Always mounted (like GlobalNewTaskDialog) so
// any entry point — the topbar Orchestrator button, the sidebar per-project icon
// — can start an orchestrator via the ui-store `orchestratorLaunchRequest`
// signal. Decides in one place: an orchestrator already running → just open it;
// a cloud target available → show the Local/Cloud dialog; otherwise start local
// directly (no dialog, no friction for non-cloud setups).
export function GlobalOrchestratorLaunchDialog() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const request = useUiStore((state) => state.orchestratorLaunchRequest);
	const workspaceQuery = useWorkspaceQuery();
	const capsQuery = useQuery({ queryKey: ["cloud-capabilities"], queryFn: cloudCapabilities, staleTime: 60_000 });
	const [open, setOpen] = useState(false);
	const [projectId, setProjectId] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const lastNonce = useRef(0);

	const launch = async (pid: string, cloud: boolean) => {
		setBusy(true);
		setError(null);
		try {
			const sessionId = await spawnOrchestrator(pid, "launch_dialog", false, cloud);
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			setOpen(false);
			void navigate({ to: "/projects/$projectId/sessions/$sessionId", params: { projectId: pid, sessionId } });
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to start orchestrator");
		} finally {
			setBusy(false);
		}
	};

	useEffect(() => {
		if (!request || request.nonce === lastNonce.current) return;
		lastNonce.current = request.nonce;
		if (open) return;
		const pid = request.projectId;
		const workspace = workspaceQuery.data?.find((item) => item.id === pid);
		const active = newestActiveOrchestrator(workspace?.sessions ?? []);
		if (active) {
			// Already running → attach to it, no launcher.
			void navigate({ to: "/projects/$projectId/sessions/$sessionId", params: { projectId: pid, sessionId: active.id } });
			return;
		}
		if (!capsQuery.data?.configured) {
			// No cloud target → start local straight away (no needless dialog).
			void launch(pid, false);
			return;
		}
		setError(null);
		setProjectId(pid);
		setOpen(true);
		// launch/navigate/query deps are stable for this one-shot signal effect.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [request]);

	return (
		<OrchestratorLaunchDialog
			open={open}
			busy={busy}
			error={error}
			onChoose={(cloud) => projectId && void launch(projectId, cloud)}
			onOpenChange={(next) => {
				if (!busy) setOpen(next);
			}}
		/>
	);
}
