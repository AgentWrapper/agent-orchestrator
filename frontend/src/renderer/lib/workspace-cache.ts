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
type IdleCallbackWindow = Window & Partial<Pick<Window, "requestIdleCallback" | "cancelIdleCallback">>;

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

const agentProviders = new Set([
	"codex",
	"claude-code",
	"opencode",
	"aider",
	"grok",
	"droid",
	"amp",
	"agy",
	"crush",
	"cursor",
	"qwen",
	"copilot",
	"goose",
	"auggie",
	"continue",
	"devin",
	"cline",
	"kimi",
	"kiro",
	"kilocode",
	"vibe",
	"pi",
	"autohand",
	"fake",
]);
const sessionStatuses = new Set([
	"working",
	"pr_open",
	"draft",
	"ci_failed",
	"review_pending",
	"changes_requested",
	"approved",
	"mergeable",
	"merged",
	"needs_input",
	"exited",
	"no_signal",
	"idle",
	"terminated",
	"unknown",
]);
const activityStates = new Set(["active", "idle", "waiting_input", "blocked", "exited", "unknown"]);
const prStates = new Set(["open", "draft", "merged", "closed"]);

function isOptional(value: unknown, validate: (candidate: unknown) => boolean): boolean {
	return value === undefined || validate(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isPullRequest(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		typeof value.url === "string" &&
		isFiniteNumber(value.number) &&
		typeof value.state === "string" &&
		prStates.has(value.state) &&
		typeof value.ci === "string" &&
		typeof value.review === "string" &&
		typeof value.mergeability === "string" &&
		typeof value.reviewComments === "boolean" &&
		typeof value.updatedAt === "string"
	);
}

function isSessionActivity(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.state === "string" &&
		activityStates.has(value.state) &&
		typeof value.lastActivityAt === "string"
	);
}

function isChangedFile(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.path === "string" &&
		isFiniteNumber(value.additions) &&
		isFiniteNumber(value.deletions) &&
		isOptional(value.staged, (candidate) => typeof candidate === "boolean")
	);
}

function isWorkspaceSession(value: unknown): value is WorkspaceSession {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.workspaceId === "string" &&
		typeof value.workspaceName === "string" &&
		typeof value.title === "string" &&
		typeof value.provider === "string" &&
		agentProviders.has(value.provider) &&
		typeof value.status === "string" &&
		sessionStatuses.has(value.status) &&
		typeof value.updatedAt === "string" &&
		isOptional(value.terminalHandleId, (candidate) => typeof candidate === "string") &&
		isOptional(value.issueId, (candidate) => typeof candidate === "string") &&
		isOptional(value.kind, (candidate) => candidate === "worker" || candidate === "orchestrator") &&
		isOptional(value.branch, (candidate) => typeof candidate === "string") &&
		isOptional(
			value.scmStatus,
			(candidate) => typeof candidate === "string" && sessionStatuses.has(candidate),
		) &&
		isOptional(value.isTerminated, (candidate) => typeof candidate === "boolean") &&
		isOptional(value.terminateOnPrMerge, (candidate) => typeof candidate === "boolean") &&
		isOptional(value.createdAt, (candidate) => typeof candidate === "string") &&
		isOptional(value.activity, isSessionActivity) &&
		isOptional(value.previewUrl, (candidate) => typeof candidate === "string") &&
		isOptional(value.previewRevision, isFiniteNumber) &&
		isOptional(
			value.changedFiles,
			(candidate) => Array.isArray(candidate) && candidate.every(isChangedFile),
		) &&
		isOptional(value.commitMessage, (candidate) => typeof candidate === "string") &&
		Array.isArray(value.prs) &&
		value.prs.every(isPullRequest)
	);
}

function isWorkspaceRepo(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		typeof value.relativePath === "string" &&
		typeof value.repo === "string"
	);
}

function isWorkspaceSummary(value: unknown): value is WorkspaceSummary {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.path === "string" &&
		isOptional(
			value.kind,
			(candidate) => candidate === "single_repo" || candidate === "workspace" || candidate === "scratch",
		) &&
		isOptional(
			value.workspaceRepos,
			(candidate) => Array.isArray(candidate) && candidate.every(isWorkspaceRepo),
		) &&
		isOptional(value.type, (candidate) => candidate === "main" || candidate === "worktree") &&
		isOptional(
			value.orchestratorAgent,
			(candidate) => typeof candidate === "string" && agentProviders.has(candidate),
		) &&
		isOptional(value.accentColor, (candidate) => typeof candidate === "string") &&
		isOptional(
			value.diff,
			(candidate) =>
				isRecord(candidate) &&
				isFiniteNumber(candidate.additions) &&
				isFiniteNumber(candidate.deletions),
		) &&
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
	let pendingData: WorkspaceSummary[] | undefined;
	let cancelScheduledWrite: (() => void) | undefined;

	const discardPending = () => {
		cancelScheduledWrite?.();
		cancelScheduledWrite = undefined;
		pendingData = undefined;
	};

	const flush = (workspaces = pendingData ?? queryClient.getQueryData<WorkspaceSummary[]>(workspaceQueryKey)) => {
		discardPending();
		if (workspaces === undefined) return;
		writeWorkspaceSnapshot(workspaces, storage);
		lastSavedData = workspaces;
	};

	const schedule = (workspaces: WorkspaceSummary[]) => {
		pendingData = workspaces;
		if (cancelScheduledWrite) return;

		const idleWindow = typeof window === "undefined" ? undefined : (window as IdleCallbackWindow);
		if (idleWindow?.requestIdleCallback && idleWindow.cancelIdleCallback) {
			const handle = idleWindow.requestIdleCallback(() => flush(), { timeout: 500 });
			cancelScheduledWrite = () => idleWindow.cancelIdleCallback?.(handle);
			return;
		}

		const handle = setTimeout(() => flush(), 0);
		cancelScheduledWrite = () => clearTimeout(handle);
	};

	const persistCurrent = () => flush();

	const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
		if (!isWorkspaceQuery(event.query.queryKey)) return;
		const workspaces = event.query.state.data;
		if (!Array.isArray(workspaces)) return;
		if (workspaces === lastSavedData) {
			discardPending();
			return;
		}
		if (workspaces === pendingData) return;
		schedule(workspaces as WorkspaceSummary[]);
	});

	if (typeof window !== "undefined") {
		window.addEventListener("beforeunload", persistCurrent);
		window.addEventListener("pagehide", persistCurrent);
	}

	return () => {
		unsubscribe();
		flush();
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
