// Standalone shell terminals: shells the user opens by hand from the topbar or
// Ctrl+`, with no agent session behind them. They are deliberately kept out of
// the workspaces query — they are not sessions, never appear on the board, and
// must not invalidate session state when they come and go.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, hasTrustedApiBaseUrl } from "../lib/api-client";
import { mockShellTerminals } from "../lib/mock-data";

export type ShellTerminal = {
	/** Runtime handle the terminal mux attaches to, exactly like a session pane's. */
	handleId: string;
	projectId?: string;
	workingDir: string;
	title: string;
	createdAt: string;
};

export const shellTerminalsQueryKey = ["shell-terminals"] as const;
const usePreviewData = import.meta.env.VITE_NO_ELECTRON === "1";

function toShellTerminal(t: components["schemas"]["ShellTerminalResponse"]): ShellTerminal {
	return {
		handleId: t.handleId,
		projectId: t.projectId,
		workingDir: t.workingDir,
		title: t.title,
		createdAt: t.createdAt,
	};
}

// Preview-only shell list. The browser build has no daemon to spawn a PTY, so
// open/close mutate this array instead — keeping the tab strip fully
// interactive (open, select, close) without a backend, which is what the e2e
// suite drives.
let previewShellTerminals: ShellTerminal[] = [...mockShellTerminals];
let previewShellSeq = 0;

async function fetchShellTerminals(): Promise<ShellTerminal[]> {
	if (usePreviewData) {
		return previewShellTerminals;
	}
	if (!hasTrustedApiBaseUrl()) {
		return [];
	}
	const { data, error } = await apiClient.GET("/api/v1/shell-terminals");
	if (error) throw error;
	return (data?.shellTerminals ?? []).map(toShellTerminal);
}

// No refetchInterval: shell terminals only change when this client opens or
// closes one, and both mutations invalidate the query. Polling would spend a
// liveness probe per shell per interval for no new information.
export const shellTerminalsQueryOptions = {
	queryKey: shellTerminalsQueryKey,
	queryFn: fetchShellTerminals,
	retry: 1,
};

export function useShellTerminals() {
	return useQuery(shellTerminalsQueryOptions);
}

/** Opens a shell in the given project's root, or the daemon data dir when omitted. */
export function useOpenShellTerminal() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (projectId?: string): Promise<ShellTerminal> => {
			if (usePreviewData) {
				previewShellSeq += 1;
				const shell: ShellTerminal = {
					handleId: `shellterm-preview-${previewShellSeq}`,
					projectId,
					workingDir: `/Users/demo/Projects/${projectId ?? "ao"}`,
					title: projectId ?? "shell",
					createdAt: new Date().toISOString(),
				};
				previewShellTerminals = [...previewShellTerminals, shell];
				return shell;
			}
			const { data, error } = await apiClient.POST("/api/v1/shell-terminals", {
				body: projectId ? { projectId } : {},
			});
			if (error) throw error;
			if (!data) throw new Error("Daemon returned no shell terminal");
			return toShellTerminal(data.shellTerminal);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey });
		},
	});
}

/** Closes a shell and destroys its PTY. */
export function useCloseShellTerminal() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (handleId: string): Promise<void> => {
			if (usePreviewData) {
				previewShellTerminals = previewShellTerminals.filter((s) => s.handleId !== handleId);
				return;
			}
			const { error } = await apiClient.DELETE("/api/v1/shell-terminals/{handleId}", {
				params: { path: { handleId } },
			});
			if (error) throw error;
		},
		// Settled, not success: a close that 404s means the daemon already lost
		// the shell, and the stale tab still needs to disappear.
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey });
		},
	});
}
