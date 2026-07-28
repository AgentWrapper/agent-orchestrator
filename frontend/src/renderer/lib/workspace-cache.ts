import type { QueryClient } from "@tanstack/react-query";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import type { WorkspaceSession, WorkspaceSummary } from "../types/workspace";

const WORKSPACE_SNAPSHOT_VERSION = 1;
export const WORKSPACE_SNAPSHOT_STORAGE_KEY = "ao.workspace-snapshot";

type WorkspaceSnapshot = {
	version: typeof WORKSPACE_SNAPSHOT_VERSION;
	savedAt: number;
	workspaces: WorkspaceSummary[];
};

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

function browserStorage(): Storage | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkspaceSession(value: unknown): value is WorkspaceSession {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.workspaceId === "string" &&
		typeof value.workspaceName === "string" &&
		typeof value.title === "string" &&
		typeof value.provider === "string" &&
		typeof value.status === "string" &&
		typeof value.updatedAt === "string" &&
		Array.isArray(value.prs)
	);
}

function isWorkspaceSummary(value: unknown): value is WorkspaceSummary {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.path === "string" &&
		Array.isArray(value.sessions) &&
		value.sessions.every(isWorkspaceSession)
	);
}

function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
	if (!isRecord(value)) return false;
	return (
		value.version === WORKSPACE_SNAPSHOT_VERSION &&
		typeof value.savedAt === "number" &&
		Number.isFinite(value.savedAt) &&
		Array.isArray(value.workspaces) &&
		value.workspaces.every(isWorkspaceSummary)
	);
}

export function readWorkspaceSnapshot(storage: ReadableStorage | null = browserStorage()): WorkspaceSnapshot | null {
	if (!storage) return null;
	try {
		const raw = storage.getItem(WORKSPACE_SNAPSHOT_STORAGE_KEY);
		if (!raw) return null;
		const snapshot: unknown = JSON.parse(raw);
		return isWorkspaceSnapshot(snapshot) ? snapshot : null;
	} catch {
		return null;
	}
}

export function writeWorkspaceSnapshot(
	workspaces: WorkspaceSummary[],
	storage: WritableStorage | null = browserStorage(),
	now = Date.now(),
): void {
	if (!storage) return;
	try {
		const snapshot: WorkspaceSnapshot = {
			version: WORKSPACE_SNAPSHOT_VERSION,
			savedAt: now,
			workspaces,
		};
		storage.setItem(WORKSPACE_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
	} catch {
		// A UI cache must never prevent AO from starting or closing.
	}
}

export function restoreWorkspaceSnapshot(
	queryClient: QueryClient,
	storage: ReadableStorage | null = browserStorage(),
): WorkspaceSummary[] | undefined {
	const snapshot = readWorkspaceSnapshot(storage);
	if (!snapshot) return undefined;
	queryClient.setQueryData(workspaceQueryKey, snapshot.workspaces, { updatedAt: snapshot.savedAt });
	return snapshot.workspaces;
}

function isWorkspaceQuery(queryKey: readonly unknown[]): boolean {
	return queryKey.length === workspaceQueryKey.length && queryKey.every((part, index) => part === workspaceQueryKey[index]);
}

export function startWorkspaceSnapshotPersistence(
	queryClient: QueryClient,
	storage: WritableStorage | null = browserStorage(),
): () => void {
	let lastSavedData = queryClient.getQueryData<WorkspaceSummary[]>(workspaceQueryKey);

	const persistCurrent = () => {
		const workspaces = queryClient.getQueryData<WorkspaceSummary[]>(workspaceQueryKey);
		if (workspaces === undefined) return;
		writeWorkspaceSnapshot(workspaces, storage);
		lastSavedData = workspaces;
	};

	const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
		if (!isWorkspaceQuery(event.query.queryKey)) return;
		const workspaces = event.query.state.data;
		if (!Array.isArray(workspaces) || workspaces === lastSavedData) return;
		writeWorkspaceSnapshot(workspaces as WorkspaceSummary[], storage);
		lastSavedData = workspaces as WorkspaceSummary[];
	});

	if (typeof window !== "undefined") {
		window.addEventListener("beforeunload", persistCurrent);
		window.addEventListener("pagehide", persistCurrent);
	}

	return () => {
		unsubscribe();
		if (typeof window !== "undefined") {
			window.removeEventListener("beforeunload", persistCurrent);
			window.removeEventListener("pagehide", persistCurrent);
		}
	};
}

export function initializeWorkspaceSnapshotCache(queryClient: QueryClient): () => void {
	restoreWorkspaceSnapshot(queryClient);
	return startWorkspaceSnapshotPersistence(queryClient);
}
