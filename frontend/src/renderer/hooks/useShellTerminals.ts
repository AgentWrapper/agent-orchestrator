// Standalone shell terminals: shells the user opens by hand from the topbar or
// Ctrl+`, with no agent session behind them. They are deliberately kept out of
// the workspaces query — they are not sessions, never appear on the board, and
// must not invalidate session state when they come and go.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { components } from "../../api/schema";
import { apiClient, hasTrustedApiBaseUrl } from "../lib/api-client";
import { mockShellTerminals } from "../lib/mock-data";

export type ShellTerminal = {
	/** Runtime handle the terminal mux attaches to, exactly like a session pane's. */
	handleId: string;
	projectId?: string;
	/** Agent session this shell is scoped to; absent for standalone shells. */
	sessionId?: string;
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
		sessionId: t.sessionId,
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

// Same rule the daemon uses: one past the highest number already on screen for
// this session, so closing "Terminal 1" does not hand the next tab that name
// while "Terminal 2" is still open.
function previewSessionTerminalTitle(sessionId: string): string {
	const highest = previewShellTerminals
		.filter((shell) => shell.sessionId === sessionId)
		.reduce((max, shell) => {
			const match = /^Terminal (\d+)$/.exec(shell.title);
			const n = match ? Number(match[1]) : 0;
			return n > max ? n : max;
		}, 0);
	return `Terminal ${highest + 1}`;
}

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

/**
 * Asks the daemon to re-check its shell list. Used when a pane reports that its
 * PTY ended: that signal is not proof of death (the attach loop reports the
 * same "exited" after it gives up on a failing liveness probe), so the client
 * must not close anything itself. The daemon's list prunes only shells it can
 * confirm are gone and keeps ones whose probe errored, which is exactly the
 * conservative rule this needs.
 */
export function useRefreshShellTerminals() {
	const queryClient = useQueryClient();
	return useCallback(
		() => void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey }),
		[queryClient],
	);
}

export type OpenShellTerminalInput = { projectId?: string; sessionId?: string };

/**
 * Opens a shell in the given project's root (or the daemon data dir when
 * omitted). When sessionId is set the shell is scoped to that session and only
 * appears in its tab strip; otherwise it is a standalone shell on /terminals.
 */
export function useOpenShellTerminal() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({ projectId, sessionId }: OpenShellTerminalInput = {}): Promise<ShellTerminal> => {
			if (usePreviewData) {
				previewShellSeq += 1;
				// Mirror the daemon: a session's shells start in that session's
				// worktree and are numbered within it, standalone shells start in
				// the project root and are named after it. The mock used to stamp
				// the project name on every tab, which is not what the app does.
				const shell: ShellTerminal = {
					handleId: `shellterm-preview-${previewShellSeq}`,
					projectId,
					sessionId,
					workingDir: sessionId
						? `/Users/demo/.ao/data/worktrees/${projectId ?? "ao"}/${sessionId}`
						: `/Users/demo/Projects/${projectId ?? "ao"}`,
					title: sessionId ? previewSessionTerminalTitle(sessionId) : (projectId ?? "shell"),
					createdAt: new Date().toISOString(),
				};
				previewShellTerminals = [...previewShellTerminals, shell];
				return shell;
			}
			const body: OpenShellTerminalInput = {};
			if (projectId) body.projectId = projectId;
			if (sessionId) body.sessionId = sessionId;
			const { data, error } = await apiClient.POST("/api/v1/shell-terminals", { body });
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
		// Drop the tab before the request goes out. The daemon's DELETE reaps the
		// pane's leftover processes before it answers, so waiting on the round
		// trip left a dead tab on screen for seconds after the click.
		onMutate: async (handleId) => {
			await queryClient.cancelQueries({ queryKey: shellTerminalsQueryKey });
			queryClient.setQueryData<ShellTerminal[]>(shellTerminalsQueryKey, (current) =>
				(current ?? []).filter((shell) => shell.handleId !== handleId),
			);
		},
		// Settled, not success: a close that 404s means the daemon already lost
		// the shell, and the stale tab still needs to disappear. This refetch is
		// also the rollback — a close that genuinely failed leaves the shell in
		// the daemon's list, so it comes straight back into the strip.
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey });
		},
	});
}

export type RenameShellTerminalInput = { handleId: string; title: string };

/** Renames a shell terminal's tab. The new title persists on the daemon. */
export function useRenameShellTerminal() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({ handleId, title }: RenameShellTerminalInput): Promise<ShellTerminal> => {
			if (usePreviewData) {
				previewShellTerminals = previewShellTerminals.map((s) => (s.handleId === handleId ? { ...s, title } : s));
				const shell = previewShellTerminals.find((s) => s.handleId === handleId);
				if (!shell) throw new Error("No such shell terminal");
				return shell;
			}
			const { data, error } = await apiClient.PATCH("/api/v1/shell-terminals/{handleId}", {
				params: { path: { handleId } },
				body: { title },
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
