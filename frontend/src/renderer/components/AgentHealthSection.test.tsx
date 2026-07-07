import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHealthSection } from "./AgentHealthSection";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock },
	apiErrorMessage: (e: unknown, fb = "Request failed") =>
		e instanceof Error ? e.message : ((e as { message?: string })?.message ?? fb),
}));

function renderSection() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<AgentHealthSection />
		</QueryClientProvider>,
	);
	return qc;
}

// openapi-fetch always hands back a `response`; success/error branches key off it.
function ok(body: unknown) {
	return { data: body, error: undefined, response: { status: 200 } as Response };
}

beforeEach(() => {
	getMock.mockReset();
});

describe("AgentHealthSection", () => {
	it("renders each harness with its status, and reason + remedy when unhealthy", async () => {
		getMock.mockResolvedValue(
			ok({
				checkedAt: "2026-07-07T12:00:00Z",
				harnesses: [
					{ id: "claude", label: "Claude", health: "healthy", changedAt: "x", checkedAt: "x" },
					{
						id: "codex",
						label: "Codex",
						health: "unauthorized",
						reason: "not authenticated (login expired or logged out)",
						remedy: "run `codex login`",
						changedAt: "x",
						checkedAt: "x",
					},
				],
			}),
		);
		renderSection();

		expect(await screen.findByText("Claude")).toBeInTheDocument();
		expect(screen.getByText("Healthy")).toBeInTheDocument();
		expect(screen.getByText("Codex")).toBeInTheDocument();
		expect(screen.getByText("Not authorized")).toBeInTheDocument();
		expect(screen.getByText(/not authenticated/i)).toBeInTheDocument();
		expect(screen.getByText(/codex login/)).toBeInTheDocument();
		expect(screen.getByText(/Last checked/)).toBeInTheDocument();
	});

	it("does not show reason/remedy for a healthy harness", async () => {
		getMock.mockResolvedValue(
			ok({
				checkedAt: "2026-07-07T12:00:00Z",
				harnesses: [
					{
						id: "claude",
						label: "Claude",
						health: "healthy",
						reason: "should be hidden",
						remedy: "should be hidden",
						changedAt: "x",
						checkedAt: "x",
					},
				],
			}),
		);
		renderSection();

		await screen.findByText("Claude");
		expect(screen.queryByText("should be hidden")).not.toBeInTheDocument();
	});

	it("shows an empty state when no harnesses are configured", async () => {
		getMock.mockResolvedValue(ok({ checkedAt: "2026-07-07T12:00:00Z", harnesses: [] }));
		renderSection();
		expect(await screen.findByText(/No agent health data yet/i)).toBeInTheDocument();
	});

	it("treats a 501 as gracefully unavailable, not an error", async () => {
		getMock.mockResolvedValue({ data: undefined, error: { message: "not implemented" }, response: { status: 501 } });
		renderSection();
		expect(await screen.findByText(/isn't available in this build/i)).toBeInTheDocument();
	});

	it("shows an error state when the request fails", async () => {
		getMock.mockResolvedValue({ data: undefined, error: { message: "boom" }, response: { status: 500 } });
		renderSection();
		// The hook keeps its own retry: 1 (survives the test client's retry: false),
		// so the error surfaces only after one backoff — allow for it.
		await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument(), { timeout: 4000 });
	});
});
