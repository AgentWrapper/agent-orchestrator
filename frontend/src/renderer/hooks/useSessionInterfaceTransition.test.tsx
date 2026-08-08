import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock, POST: vi.fn(), DELETE: vi.fn() },
	apiErrorMessage: () => "request failed",
	hasTrustedApiBaseUrl: () => true,
}));

import { useSessionInterfaceTransition } from "./useSessionInterfaceTransition";

function wrapper({ children }: { children: ReactNode }) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
	getMock.mockReset();
});

describe("interface switch readiness", () => {
	it("rechecks a missing native session until the switch becomes supported", async () => {
		getMock
			.mockResolvedValueOnce({
				data: {
					supported: false,
					targetMode: "chat",
					reasonCode: "NATIVE_SESSION_MISSING",
					reason: "no native conversation found for codex",
				},
				error: undefined,
			})
			.mockResolvedValue({
				data: { supported: true, targetMode: "chat" },
				error: undefined,
			});

		const { result } = renderHook(() => useSessionInterfaceTransition("session-1"), {
			wrapper,
		});

		await waitFor(() => expect(result.current.status?.supported).toBe(false));
		await waitFor(() => expect(result.current.status?.supported).toBe(true), {
			timeout: 2_500,
		});
		expect(getMock).toHaveBeenCalledTimes(2);
	});

	it("does not poll a permanently unsupported interface handoff", async () => {
		getMock.mockResolvedValue({
			data: {
				supported: false,
				targetMode: "chat",
				reasonCode: "INTERFACE_HANDOFF_UNSUPPORTED",
				reason: "cursor has not declared compatible TUI and Chat identities",
			},
			error: undefined,
		});

		const { result } = renderHook(() => useSessionInterfaceTransition("session-1"), {
			wrapper,
		});

		await waitFor(() => expect(result.current.status?.supported).toBe(false));
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		expect(getMock).toHaveBeenCalledTimes(1);
	});
});
