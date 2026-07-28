import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import type { WorkspaceSummary } from "../types/workspace";
import {
	WORKSPACE_SNAPSHOT_STORAGE_KEY,
	readWorkspaceSnapshot,
	restoreWorkspaceSnapshot,
	startWorkspaceSnapshotPersistence,
	writeWorkspaceSnapshot,
} from "./workspace-cache";

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		values,
	};
}

const workspaces: WorkspaceSummary[] = [
	{
		id: "project-1",
		name: "AO",
		path: "/repo/ao",
		sessions: [
			{
				id: "session-1",
				workspaceId: "project-1",
				workspaceName: "AO",
				title: "Keep startup state",
				provider: "codex",
				status: "working",
				updatedAt: "2026-07-28T08:00:00Z",
				prs: [],
			},
		],
	},
];

describe("workspace snapshot cache", () => {
	let storage: ReturnType<typeof memoryStorage>;

	beforeEach(() => {
		storage = memoryStorage();
	});

	it("round-trips a versioned workspace snapshot", () => {
		writeWorkspaceSnapshot(workspaces, storage, 1234);

		expect(readWorkspaceSnapshot(storage)).toEqual({
			version: 1,
			savedAt: 1234,
			workspaces,
		});
	});

	it("ignores corrupt, incompatible, and structurally invalid snapshots", () => {
		storage.setItem(WORKSPACE_SNAPSHOT_STORAGE_KEY, "{bad json");
		expect(readWorkspaceSnapshot(storage)).toBeNull();

		storage.setItem(
			WORKSPACE_SNAPSHOT_STORAGE_KEY,
			JSON.stringify({ version: 2, savedAt: 1234, workspaces }),
		);
		expect(readWorkspaceSnapshot(storage)).toBeNull();

		storage.setItem(
			WORKSPACE_SNAPSHOT_STORAGE_KEY,
			JSON.stringify({ version: 1, savedAt: 1234, workspaces: [{ id: "broken" }] }),
		);
		expect(readWorkspaceSnapshot(storage)).toBeNull();
	});

	it("rejects malformed nested session state", () => {
		for (const invalidSession of [
			{ ...workspaces[0]!.sessions[0]!, prs: [null] },
			{ ...workspaces[0]!.sessions[0]!, provider: "not-an-agent" },
			{ ...workspaces[0]!.sessions[0]!, status: "running" },
			{
				...workspaces[0]!.sessions[0]!,
				activity: { state: "working", lastActivityAt: "2026-07-28T08:00:00Z" },
			},
			{
				...workspaces[0]!.sessions[0]!,
				prs: [
					{
						url: "https://github.com/acme/ao/pull/1",
						number: 1,
						state: "unknown",
						ci: "pending",
						review: "none",
						mergeability: "unknown",
						reviewComments: false,
						updatedAt: "2026-07-28T08:00:00Z",
					},
				],
			},
		]) {
			storage.setItem(
				WORKSPACE_SNAPSHOT_STORAGE_KEY,
				JSON.stringify({
					version: 1,
					savedAt: 1234,
					workspaces: [{ ...workspaces[0], sessions: [invalidSession] }],
				}),
			);
			expect(readWorkspaceSnapshot(storage)).toBeNull();
		}
	});

	it("restores cached workspaces with their original save time", () => {
		writeWorkspaceSnapshot(workspaces, storage, 1234);
		const queryClient = new QueryClient();

		expect(restoreWorkspaceSnapshot(queryClient, storage)).toEqual(workspaces);
		expect(queryClient.getQueryData(workspaceQueryKey)).toEqual(workspaces);
		expect(queryClient.getQueryState(workspaceQueryKey)?.dataUpdatedAt).toBe(1234);
	});

	it("persists query changes, including a real empty daemon response", () => {
		const queryClient = new QueryClient();
		const stop = startWorkspaceSnapshotPersistence(queryClient, storage);

		queryClient.setQueryData(workspaceQueryKey, workspaces);
		expect(readWorkspaceSnapshot(storage)?.workspaces).toEqual(workspaces);

		queryClient.setQueryData(workspaceQueryKey, []);
		expect(readWorkspaceSnapshot(storage)?.workspaces).toEqual([]);

		stop();
	});

	it("flushes the current query state when the renderer closes", () => {
		const queryClient = new QueryClient();
		const stop = startWorkspaceSnapshotPersistence(queryClient, storage);
		queryClient.setQueryData(workspaceQueryKey, workspaces);
		storage.values.delete(WORKSPACE_SNAPSHOT_STORAGE_KEY);

		window.dispatchEvent(new Event("beforeunload"));

		expect(readWorkspaceSnapshot(storage)?.workspaces).toEqual(workspaces);
		stop();
	});

	it("never throws when browser storage is unavailable", () => {
		const brokenStorage = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("quota");
			},
		};

		expect(readWorkspaceSnapshot(brokenStorage)).toBeNull();
		expect(() => writeWorkspaceSnapshot(workspaces, brokenStorage)).not.toThrow();
	});
});
