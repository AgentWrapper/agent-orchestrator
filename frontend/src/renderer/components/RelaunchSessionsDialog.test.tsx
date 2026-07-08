import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMock, postMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: getMock,
		POST: postMock,
	},
	apiErrorMessage: (error: unknown, fallback = "Request failed") => {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error) {
			return String((error as { message: unknown }).message);
		}
		return fallback;
	},
}));

import { RelaunchSessionsDialog } from "./RelaunchSessionsDialog";

function renderDialog(open = true) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const onOpenChange = vi.fn();
	const onDone = vi.fn();
	render(
		<QueryClientProvider client={queryClient}>
			<RelaunchSessionsDialog
				open={open}
				projectId="proj-1"
				onOpenChange={onOpenChange}
				onDone={onDone}
			/>
		</QueryClientProvider>,
	);
	return { queryClient, onOpenChange, onDone };
}

beforeEach(() => {
	getMock.mockReset();
	postMock.mockReset();
});

describe("RelaunchSessionsDialog", () => {
	it("renders confirm and relaunch button when count > 0", async () => {
		getMock.mockResolvedValue({
			data: {
				count: 2,
				affected: [
					{ sessionId: "s1", title: "Fix auth", kind: "worker", fromMode: "default", toMode: "auto" },
					{ sessionId: "s2", title: "Add tests", kind: "worker", fromMode: "default", toMode: "auto" },
				],
			},
			error: undefined,
		});

		renderDialog();

		// findByRole waits for the async query to settle
		const relaunchBtn = await screen.findByRole("button", { name: "Relaunch 2 sessions" });
		expect(relaunchBtn).toBeInTheDocument();
		expect(screen.getByText("Fix auth")).toBeInTheDocument();
		expect(screen.getByText("Add tests")).toBeInTheDocument();
	});

	it("calls apiClient.POST with the relaunch path on confirm", async () => {
		getMock.mockResolvedValue({
			data: {
				count: 2,
				affected: [
					{ sessionId: "s1", title: "Fix auth", kind: "worker", fromMode: "default", toMode: "auto" },
					{ sessionId: "s2", title: "Add tests", kind: "worker", fromMode: "default", toMode: "auto" },
				],
			},
			error: undefined,
		});
		postMock.mockResolvedValue({
			data: {
				relaunched: 2,
				failed: 0,
				results: [
					{ sessionId: "s1", ok: true },
					{ sessionId: "s2", ok: true },
				],
			},
			error: undefined,
		});

		renderDialog();

		const relaunchBtn = await screen.findByRole("button", { name: "Relaunch 2 sessions" });
		await userEvent.click(relaunchBtn);

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/v1/projects/{id}/permission-relaunch", {
			params: { path: { id: "proj-1" } },
		});
	});
});
