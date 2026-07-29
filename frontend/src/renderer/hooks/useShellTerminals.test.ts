import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	beginOpenShellTerminalActivation,
	isLatestOpenShellTerminalActivation,
	isPendingShellHandleId,
	shellTerminalsQueryKey,
	useCloseShellTerminal,
	useOpenShellTerminal,
	type ShellTerminal,
} from "./useShellTerminals";

vi.mock("../lib/api-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/api-client")>();
	return {
		...actual,
		hasTrustedApiBaseUrl: () => true,
		apiClient: {
			POST: vi.fn(),
			GET: vi.fn(),
			DELETE: vi.fn(),
		},
	};
});

const { apiClient } = await import("../lib/api-client");

function wrapper(queryClient: QueryClient) {
	return ({ children }: { children: ReactNode }) =>
		createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useOpenShellTerminal", () => {
	afterEach(() => {
		vi.mocked(apiClient.POST).mockReset();
		vi.mocked(apiClient.DELETE).mockReset();
		vi.mocked(apiClient.GET).mockReset();
	});

	it("adds an optimistic tab immediately and replaces it on success without refetching", async () => {
		const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		const created: ShellTerminal = {
			handleId: "sh-real",
			projectId: "proj-1",
			sessionId: "sess-1",
			workingDir: "/tmp/ws",
			title: "agent-orchestrator-1",
			createdAt: "2026-07-29T00:00:00Z",
		};
		vi.mocked(apiClient.POST).mockImplementation(
			() =>
				new Promise((resolve) => {
					setTimeout(
						() =>
							resolve({
								data: { shellTerminal: created },
								error: undefined,
							}),
						20,
					);
				}),
		);

		const { result } = renderHook(() => useOpenShellTerminal(), { wrapper: wrapper(queryClient) });
		const generation = beginOpenShellTerminalActivation();
		await act(async () => {
			result.current.mutate({ projectId: "proj-1", sessionId: "sess-1", activationGeneration: generation });
		});

		const pendingTabs = queryClient.getQueryData<ShellTerminal[]>(shellTerminalsQueryKey);
		expect(pendingTabs?.some((tab) => isPendingShellHandleId(tab.handleId))).toBe(true);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		const tabs = queryClient.getQueryData<ShellTerminal[]>(shellTerminalsQueryKey);
		expect(tabs).toEqual([created]);
		expect(vi.mocked(apiClient.GET)).not.toHaveBeenCalled();
		expect(isLatestOpenShellTerminalActivation(generation)).toBe(true);
	});

	it("does not resurrect a pending tab closed before POST completes", async () => {
		const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		const created: ShellTerminal = {
			handleId: "sh-real",
			projectId: "proj-1",
			sessionId: "sess-1",
			workingDir: "/tmp/ws",
			title: "agent-orchestrator-1",
			createdAt: "2026-07-29T00:00:00Z",
		};
		let resolvePost: ((value: unknown) => void) | undefined;
		vi.mocked(apiClient.POST).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolvePost = resolve;
				}),
		);
		vi.mocked(apiClient.DELETE).mockResolvedValue({ data: undefined, error: undefined });

		const open = renderHook(() => useOpenShellTerminal(), { wrapper: wrapper(queryClient) });
		const close = renderHook(() => useCloseShellTerminal(), { wrapper: wrapper(queryClient) });

		await act(async () => {
			open.result.current.mutate({ projectId: "proj-1", sessionId: "sess-1" });
		});
		const pendingId = queryClient
			.getQueryData<ShellTerminal[]>(shellTerminalsQueryKey)
			?.find((tab) => isPendingShellHandleId(tab.handleId))?.handleId;
		expect(pendingId).toBeDefined();

		await act(async () => {
			close.result.current.mutate(pendingId!);
		});
		expect(queryClient.getQueryData<ShellTerminal[]>(shellTerminalsQueryKey)).toEqual([]);

		await act(async () => {
			resolvePost?.({ data: { shellTerminal: created }, error: undefined });
		});
		await waitFor(() => expect(open.result.current.isSuccess).toBe(true));

		expect(queryClient.getQueryData<ShellTerminal[]>(shellTerminalsQueryKey)).toEqual([]);
		expect(vi.mocked(apiClient.DELETE)).toHaveBeenCalledWith("/api/v1/shell-terminals/{handleId}", {
			params: { path: { handleId: "sh-real" } },
		});
		expect(vi.mocked(apiClient.GET)).not.toHaveBeenCalled();
	});

	it("on open failure only removes its placeholder, not tabs closed meanwhile", async () => {
		const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		const kept: ShellTerminal = {
			handleId: "sh-kept",
			projectId: "proj-1",
			workingDir: "/tmp/ws",
			title: "kept",
			createdAt: "2026-07-29T00:00:00Z",
		};
		const doomed: ShellTerminal = {
			handleId: "sh-doomed",
			projectId: "proj-1",
			workingDir: "/tmp/ws",
			title: "doomed",
			createdAt: "2026-07-29T00:00:00Z",
		};
		queryClient.setQueryData(shellTerminalsQueryKey, [kept, doomed]);

		let rejectPost: ((reason?: unknown) => void) | undefined;
		vi.mocked(apiClient.POST).mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					rejectPost = reject;
				}),
		);
		vi.mocked(apiClient.DELETE).mockResolvedValue({ data: undefined, error: undefined });

		const open = renderHook(() => useOpenShellTerminal(), { wrapper: wrapper(queryClient) });
		const close = renderHook(() => useCloseShellTerminal(), { wrapper: wrapper(queryClient) });

		await act(async () => {
			open.result.current.mutate({ projectId: "proj-1" });
		});
		expect(
			queryClient.getQueryData<ShellTerminal[]>(shellTerminalsQueryKey)?.some((t) => isPendingShellHandleId(t.handleId)),
		).toBe(true);

		await act(async () => {
			close.result.current.mutate("sh-doomed");
		});
		expect(queryClient.getQueryData<ShellTerminal[]>(shellTerminalsQueryKey)?.map((t) => t.handleId)).not.toContain(
			"sh-doomed",
		);

		await act(async () => {
			rejectPost?.(new Error("boom"));
		});
		await waitFor(() => expect(open.result.current.isError).toBe(true));

		const tabs = queryClient.getQueryData<ShellTerminal[]>(shellTerminalsQueryKey) ?? [];
		expect(tabs.map((t) => t.handleId)).toEqual(["sh-kept"]);
		expect(tabs.some((t) => isPendingShellHandleId(t.handleId))).toBe(false);
	});
});

describe("useCloseShellTerminal", () => {
	afterEach(() => {
		vi.mocked(apiClient.DELETE).mockReset();
		vi.mocked(apiClient.GET).mockReset();
	});

	it("keeps a closed tab removed when the daemon reports it is already gone", async () => {
		const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		const existing: ShellTerminal = {
			handleId: "sh-real",
			projectId: "proj-1",
			workingDir: "/tmp/ws",
			title: "agent-orchestrator-1",
			createdAt: "2026-07-29T00:00:00Z",
		};
		queryClient.setQueryData(shellTerminalsQueryKey, [existing]);
		vi.mocked(apiClient.DELETE).mockResolvedValue({
			data: undefined,
			error: { code: "SHELL_TERMINAL_NOT_FOUND", message: "No such shell terminal" },
		});

		const { result } = renderHook(() => useCloseShellTerminal(), { wrapper: wrapper(queryClient) });
		await act(async () => {
			result.current.mutate("sh-real");
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(queryClient.getQueryData<ShellTerminal[]>(shellTerminalsQueryKey)).toEqual([]);
		expect(vi.mocked(apiClient.GET)).not.toHaveBeenCalled();
	});
});
