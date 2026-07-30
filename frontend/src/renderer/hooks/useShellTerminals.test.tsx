import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const { deleteMock } = vi.hoisted(() => ({ deleteMock: vi.fn() }));

vi.mock("../lib/api-client", () => ({
	apiClient: { DELETE: deleteMock },
	hasTrustedApiBaseUrl: () => true,
}));

import { shellTerminalsQueryKey, useCloseShellTerminal, type ShellTerminal } from "./useShellTerminals";

const shells: ShellTerminal[] = [
	{ handleId: "sh-a", workingDir: "/p", title: "one", createdAt: "2026-07-29T00:00:00Z" },
	{ handleId: "sh-b", workingDir: "/q", title: "two", createdAt: "2026-07-29T00:00:00Z" },
];

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function cachedHandleIds() {
	return (queryClient.getQueryData<ShellTerminal[]>(shellTerminalsQueryKey) ?? []).map((s) => s.handleId);
}

beforeEach(() => {
	deleteMock.mockReset();
	queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	queryClient.setQueryData(shellTerminalsQueryKey, shells);
});

describe("useCloseShellTerminal", () => {
	// The daemon reaps the pane's leftover processes before answering the DELETE,
	// which took seconds. Waiting on that round trip left a dead tab on screen,
	// so the close must land in the cache before the request resolves.
	it("drops the tab before the daemon answers", async () => {
		let resolveDelete: (value: { error: undefined }) => void = () => undefined;
		deleteMock.mockReturnValue(
			new Promise<{ error: undefined }>((resolve) => {
				resolveDelete = resolve;
			}),
		);

		const { result } = renderHook(() => useCloseShellTerminal(), { wrapper });
		result.current.mutate("sh-a");

		// Still in flight, and the tab is already gone.
		await waitFor(() => expect(cachedHandleIds()).toEqual(["sh-b"]));
		expect(deleteMock).toHaveBeenCalledOnce();

		resolveDelete({ error: undefined });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
	});

	// The refetch on settle is the rollback: a close that genuinely failed leaves
	// the shell in the daemon's list, so it comes straight back into the strip.
	it("restores the tab when the close fails", async () => {
		deleteMock.mockResolvedValue({ error: { message: "boom" } });
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");

		const { result } = renderHook(() => useCloseShellTerminal(), { wrapper });
		result.current.mutate("sh-a");

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(invalidate).toHaveBeenCalledWith({ queryKey: shellTerminalsQueryKey });
	});
});
