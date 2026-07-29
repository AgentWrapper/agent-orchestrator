// Standalone shell terminals: shells the user opens by hand from the topbar or
// Ctrl+`, with no agent session behind them. They are deliberately kept out of
// the workspaces query — they are not sessions, never appear on the board, and
// must not invalidate session state when they come and go.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorCode, hasTrustedApiBaseUrl } from "../lib/api-client";
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
const PENDING_SHELL_PREFIX = "shell-pending-";

/** Optimistic tabs the user closed before POST completed — open must not resurrect them. */
const cancelledOptimisticShellIds = new Set<string>();

/**
 * Real daemon handles the user already dismissed (e.g. closed a pending tab whose
 * POST later succeeded). Filtered out of list fetches so a failed cleanup DELETE
 * cannot resurrect them on reload.
 */
const dismissedDaemonHandleIds = new Set<string>();

/** True for optimistic placeholder tabs that are not yet attachable. */
export function isPendingShellHandleId(handleId: string): boolean {
	return handleId.startsWith(PENDING_SHELL_PREFIX);
}

function isShellTerminalNotFound(error: unknown): boolean {
	return apiErrorCode(error) === "SHELL_TERMINAL_NOT_FOUND";
}

function cancelOptimisticShell(handleId: string): void {
	if (isPendingShellHandleId(handleId)) {
		cancelledOptimisticShellIds.add(handleId);
	}
}

function consumeCancelledOptimisticShell(optimisticId: string): boolean {
	if (!cancelledOptimisticShellIds.has(optimisticId)) return false;
	cancelledOptimisticShellIds.delete(optimisticId);
	return true;
}

function dismissDaemonShell(handleId: string): void {
	dismissedDaemonHandleIds.add(handleId);
}

function clearDismissedDaemonShell(handleId: string): void {
	dismissedDaemonHandleIds.delete(handleId);
}

function withoutDismissed(shells: ShellTerminal[]): ShellTerminal[] {
	if (dismissedDaemonHandleIds.size === 0) return shells;
	return shells.filter((shell) => !dismissedDaemonHandleIds.has(shell.handleId));
}

async function deleteShellOnDaemon(handleId: string): Promise<boolean> {
	const { error } = await apiClient.DELETE("/api/v1/shell-terminals/{handleId}", {
		params: { path: { handleId } },
	});
	if (!error || isShellTerminalNotFound(error)) {
		clearDismissedDaemonShell(handleId);
		return true;
	}
	return false;
}

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

async function fetchShellTerminals(): Promise<ShellTerminal[]> {
	if (usePreviewData) {
		return previewShellTerminals;
	}
	if (!hasTrustedApiBaseUrl()) {
		return [];
	}
	const { data, error } = await apiClient.GET("/api/v1/shell-terminals");
	if (error) throw error;
	return withoutDismissed((data?.shellTerminals ?? []).map(toShellTerminal));
}

// No refetchInterval: shell terminals only change when this client opens or
// closes one. Open/close update the cache in place; rename still invalidates.
// Polling would spend a liveness probe per shell per interval for no new information.
export const shellTerminalsQueryOptions = {
	queryKey: shellTerminalsQueryKey,
	queryFn: fetchShellTerminals,
	retry: 1,
};

export function useShellTerminals() {
	return useQuery(shellTerminalsQueryOptions);
}

export type OpenShellTerminalInput = { projectId?: string; sessionId?: string };

/** Variables for open-shell mutation; activationGeneration is client-only. */
export type OpenShellTerminalVariables = OpenShellTerminalInput & {
	/** When set, only the latest generation may switch the active pane on success. */
	activationGeneration?: number;
};

let openShellActivationGeneration = 0;
let optimisticShellSeq = 0;

/** Mark the start of an open-shell request; pass the value through mutate(). */
export function beginOpenShellTerminalActivation(): number {
	return ++openShellActivationGeneration;
}

/** True when no generation was passed, or this open is still the most recent one. */
export function isLatestOpenShellTerminalActivation(generation: number | undefined): boolean {
	return generation === undefined || generation === openShellActivationGeneration;
}

function createOptimisticShell(input: OpenShellTerminalInput, optimisticId: string): ShellTerminal {
	return {
		handleId: optimisticId,
		projectId: input.projectId,
		sessionId: input.sessionId,
		workingDir: "",
		title: "Terminal",
		createdAt: new Date().toISOString(),
	};
}

/**
 * Opens a shell in the given project's root (or the daemon data dir when
 * omitted). When sessionId is set the shell is scoped to that session and only
 * appears in its tab strip; otherwise it is a standalone shell on /terminals.
 */
export function useOpenShellTerminal() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			projectId,
			sessionId,
		}: OpenShellTerminalVariables = {}): Promise<ShellTerminal> => {
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
		onMutate: async (input) => {
			if (usePreviewData) return undefined;
			await queryClient.cancelQueries({ queryKey: shellTerminalsQueryKey });
			const optimisticId = `${PENDING_SHELL_PREFIX}${++optimisticShellSeq}`;
			const optimistic = createOptimisticShell(input, optimisticId);
			queryClient.setQueryData<ShellTerminal[]>(shellTerminalsQueryKey, (current) => [
				...(current ?? []),
				optimistic,
			]);
			return { optimisticId };
		},
		onSuccess: (shell, _input, context) => {
			if (usePreviewData) {
				void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey });
				return;
			}
			// User closed the placeholder tab while POST was in flight — discard the
			// server row so a later reload does not resurrect a dismissed shell.
			if (context?.optimisticId && consumeCancelledOptimisticShell(context.optimisticId)) {
				dismissDaemonShell(shell.handleId);
				void deleteShellOnDaemon(shell.handleId);
				return;
			}
			queryClient.setQueryData<ShellTerminal[]>(shellTerminalsQueryKey, (current) => {
				const list = current ?? [];
				if (context?.optimisticId) {
					return list.map((item) => (item.handleId === context.optimisticId ? shell : item));
				}
				if (list.some((item) => item.handleId === shell.handleId)) return list;
				return [...list, shell];
			});
		},
		onError: (_error, _input, context) => {
			// Only drop this open's placeholder — never restore a full snapshot, which
			// would resurrect tabs the user closed while the request was in flight.
			const optimisticId = context?.optimisticId;
			if (!optimisticId) return;
			cancelledOptimisticShellIds.delete(optimisticId);
			queryClient.setQueryData<ShellTerminal[]>(shellTerminalsQueryKey, (current) =>
				(current ?? []).filter((shell) => shell.handleId !== optimisticId),
			);
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
			if (isPendingShellHandleId(handleId)) {
				return;
			}
			const { error } = await apiClient.DELETE("/api/v1/shell-terminals/{handleId}", {
				params: { path: { handleId } },
			});
			if (error) throw error;
		},
		// Drop the tab from the cache immediately so the strip does not keep showing
		// a shell the pane has already left (close switches the active target first,
		// then awaits DELETE). Without this the first click looks like it only
		// selected the session tab, and a later click finally removes the shell.
		onMutate: async (handleId) => {
			if (isPendingShellHandleId(handleId)) {
				cancelOptimisticShell(handleId);
			}
			await queryClient.cancelQueries({ queryKey: shellTerminalsQueryKey });
			const previous = queryClient.getQueryData<ShellTerminal[]>(shellTerminalsQueryKey);
			queryClient.setQueryData<ShellTerminal[]>(shellTerminalsQueryKey, (current) =>
				(current ?? []).filter((shell) => shell.handleId !== handleId),
			);
			if (usePreviewData) {
				previewShellTerminals = previewShellTerminals.filter((s) => s.handleId !== handleId);
			}
			return { previous };
		},
		onError: (error, handleId, context) => {
			// Pending ids never hit the daemon; 404 means the row is already gone.
			// Keep the optimistic removal instead of rolling back the whole strip.
			if (isPendingShellHandleId(handleId) || isShellTerminalNotFound(error)) return;
			const restored = context?.previous?.find((shell) => shell.handleId === handleId);
			if (!restored) return;
			// Re-insert only this shell — other tabs closed during the request stay closed.
			queryClient.setQueryData<ShellTerminal[]>(shellTerminalsQueryKey, (current) => {
				const list = current ?? [];
				if (list.some((shell) => shell.handleId === handleId)) return list;
				const index = context.previous?.findIndex((shell) => shell.handleId === handleId) ?? list.length;
				const next = [...list];
				next.splice(Math.min(Math.max(index, 0), next.length), 0, restored);
				return next;
			});
			if (usePreviewData) {
				if (previewShellTerminals.some((s) => s.handleId === handleId)) return;
				const index = context.previous?.findIndex((s) => s.handleId === handleId) ?? previewShellTerminals.length;
				const next = [...previewShellTerminals];
				next.splice(Math.min(Math.max(index, 0), next.length), 0, restored);
				previewShellTerminals = next;
			}
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
