import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const { getMock, putMock } = vi.hoisted(() => ({ getMock: vi.fn(), putMock: vi.fn() }));

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock, PUT: putMock },
}));

import { usePipelinesSetting, useSetPipelinesSetting } from "./usePipelinesSetting";

function wrapper({ children }: { children: ReactNode }) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
	getMock.mockReset();
	putMock.mockReset();
});

describe("usePipelinesSetting", () => {
	it("returns the enabled flag from the persisted setting", async () => {
		getMock.mockResolvedValue({ data: { enabled: true } });

		const { result } = renderHook(() => usePipelinesSetting(), { wrapper });

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.enabled).toBe(true);
		expect(getMock).toHaveBeenCalledWith("/api/v1/settings/pipelines", {});
	});

	it("defaults to false when the response has no data", async () => {
		getMock.mockResolvedValue({ data: undefined });

		const { result } = renderHook(() => usePipelinesSetting(), { wrapper });

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.enabled).toBe(false);
	});
});

describe("useSetPipelinesSetting", () => {
	it("PUTs the new enabled value", async () => {
		putMock.mockResolvedValue({ data: { enabled: true } });

		const { result } = renderHook(() => useSetPipelinesSetting(), { wrapper });
		result.current.mutate(true);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(putMock).toHaveBeenCalledWith("/api/v1/settings/pipelines", { body: { enabled: true } });
	});
});
