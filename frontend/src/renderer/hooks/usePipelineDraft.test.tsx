import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock("../lib/api-client", () => ({
	apiClient: { POST: (...args: unknown[]) => postMock(...args) },
}));

import { usePipelineDraft } from "./usePipelineDraft";

function wrapper({ children }: { children: ReactNode }) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const VALID_YAML = "name: review\nstages:\n  - name: s\n";

beforeEach(() => {
	postMock.mockReset().mockResolvedValue({ data: { valid: true, issues: [] }, error: undefined });
});

describe("usePipelineDraft", () => {
	it("debounces validation and surfaces a valid result", async () => {
		const { result } = renderHook(() => usePipelineDraft(VALID_YAML), { wrapper });

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/v1/pipelines/validate", { body: { yamlSource: VALID_YAML } });
		await waitFor(() => expect(result.current.validation.valid).toBe(true));
		expect(result.current.validation.issues).toEqual([]);
	});

	it("coalesces rapid edits into a single validate call for the final text", async () => {
		vi.useFakeTimers();
		try {
			const { result } = renderHook(() => usePipelineDraft(VALID_YAML), { wrapper });
			// Three quick edits inside the debounce window.
			act(() => result.current.setYamlSource("name: a"));
			act(() => result.current.setYamlSource("name: ab"));
			act(() => result.current.setYamlSource("name: abc"));
			// Nothing fires until the window elapses.
			await act(async () => {
				vi.advanceTimersByTime(500);
			});
			// Only the last text is validated (initial mount value never settled).
			const calls = postMock.mock.calls.map((c) => (c[1] as { body: { yamlSource: string } }).body.yamlSource);
			expect(calls).toContain("name: abc");
			expect(calls).not.toContain("name: a");
			expect(calls).not.toContain("name: ab");
		} finally {
			vi.useRealTimers();
		}
	});

	it("surfaces the issue list when the daemon reports invalid", async () => {
		postMock.mockResolvedValue({
			data: { valid: false, issues: [{ path: "name", message: "name must not be empty" }] },
			error: undefined,
		});
		const { result } = renderHook(() => usePipelineDraft(VALID_YAML), { wrapper });

		await waitFor(() => expect(result.current.validation.valid).toBe(false));
		expect(result.current.validation.issues).toEqual([{ path: "name", message: "name must not be empty" }]);
	});

	it("does not validate an empty buffer", async () => {
		renderHook(() => usePipelineDraft("   "), { wrapper });
		// Give the debounce + query a chance to (not) fire.
		await new Promise((r) => setTimeout(r, 500));
		expect(postMock).not.toHaveBeenCalled();
	});

	it("exposes a draft derived from the YAML buffer", () => {
		const { result } = renderHook(() => usePipelineDraft(VALID_YAML), { wrapper });
		expect(result.current.draft.name).toBe("review");
		expect(result.current.draft.stages).toHaveLength(1);
	});
});
