import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock },
}));

import { usePipelinesEnabled } from "./usePipelinesEnabled";

function wrapper({ children }: { children: ReactNode }) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
	getMock.mockReset();
});

describe("usePipelinesEnabled", () => {
	it("reports enabled when the schema route returns 200", async () => {
		getMock.mockResolvedValue({ data: { schema: {} }, response: { status: 200 } });

		const { result } = renderHook(() => usePipelinesEnabled(), { wrapper });

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.enabled).toBe(true);
		expect(getMock).toHaveBeenCalledWith("/api/v1/pipelines/schema", {});
	});

	it("reports disabled when the schema route returns 501 (flag off)", async () => {
		getMock.mockResolvedValue({ error: { message: "not enabled" }, response: { status: 501 } });

		const { result } = renderHook(() => usePipelinesEnabled(), { wrapper });

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.enabled).toBe(false);
	});

	it("reports disabled on a network failure instead of leaving enabled undefined", async () => {
		getMock.mockRejectedValue(new TypeError("Failed to fetch"));

		const { result } = renderHook(() => usePipelinesEnabled(), { wrapper });

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.enabled).toBe(false);
	});
});
