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
	/** Agent session this shell is scoped to; absent for standalone shells. */
	sessionId?: string;
	workingDir: string;
	title: string;
	createdAt: string;
	/** Best-effort harness id sniffed from recent pane output (e.g. "kimi"). */
	detectedAgent?: string;
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
		detectedAgent: t.detectedAgent,
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

// Light polling so a shell the user is not looking at still picks up the agent
// they started in it; the daemon reports the pane's foreground process, so this
// is also what clears the label again once the agent exits.
export const shellTerminalsQueryOptions = {
	queryKey: shellTerminalsQueryKey,
	queryFn: fetchShellTerminals,
	retry: 1,
	refetchInterval: 4_000,
};

// Agents detected from the attached pane's live output stream, keyed by handle.
// Only the focused shell streams, and its banner arrives long before the next
// poll, so a live detection outranks the list for that one pane. A live *clear*
// deliberately does not: it patches the cache for instant feedback and then
// defers to the daemon, which self-corrects a misread prompt on the next poll.
const liveDetectedAgents = new Map<string, string>();

export function useShellTerminals() {
	return useQuery({
		...shellTerminalsQueryOptions,
		queryFn: async () => {
			const fresh = await fetchShellTerminals();
			if (liveDetectedAgents.size === 0) return fresh;
			return fresh.map((shell) => {
				const live = liveDetectedAgents.get(shell.handleId);
				return live ? { ...shell, detectedAgent: live } : shell;
			});
		},
	});
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
				const shell: ShellTerminal = {
					handleId: `shellterm-preview-${previewShellSeq}`,
					projectId,
					sessionId,
					workingDir: `/Users/demo/Projects/${projectId ?? "ao"}`,
					title: projectId ?? "shell",
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
		// Settled, not success: a close that 404s means the daemon already lost
		// the shell, and the stale tab still needs to disappear.
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
		onSuccess: (shell) => {
			queryClient.setQueryData<ShellTerminal[]>(shellTerminalsQueryKey, (current) => {
				if (!current) return current;
				return current.map((s) => {
					if (s.handleId !== shell.handleId) return s;
					// PATCH responses omit sniffed DetectedAgent — keep any optimistic value.
					return { ...s, ...shell, detectedAgent: shell.detectedAgent ?? s.detectedAgent };
				});
			});
			void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey });
		},
	});
}

/**
 * Record what the attached pane's own output says is running in it, and patch
 * the cache so the tab strip re-renders now instead of at the next poll. Pass
 * `undefined` when the pane returns to a bare shell prompt.
 */
export function setLiveDetectedAgent(
	queryClient: ReturnType<typeof useQueryClient>,
	handleId: string,
	detectedAgent: string | undefined,
): void {
	if (detectedAgent) {
		liveDetectedAgents.set(handleId, detectedAgent);
	} else {
		liveDetectedAgents.delete(handleId);
	}
	queryClient.setQueryData<ShellTerminal[]>(shellTerminalsQueryKey, (current) => {
		if (!current) return current;
		let changed = false;
		const next = current.map((shell) => {
			if (shell.handleId !== handleId || shell.detectedAgent === detectedAgent) return shell;
			changed = true;
			return { ...shell, detectedAgent };
		});
		return changed ? next : current;
	});
}

/** Drop a pane's live detection when it detaches, handing the tab back to the daemon. */
export function forgetLiveDetectedAgent(handleId: string): void {
	liveDetectedAgents.delete(handleId);
}
