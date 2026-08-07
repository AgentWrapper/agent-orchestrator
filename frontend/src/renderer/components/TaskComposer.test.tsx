import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), capture: vi.fn() }));

vi.mock("../hooks/useAgentsQuery", () => ({
	agentsQueryKey: ["agents"],
	agentsQueryOptions: { queryKey: ["agents"], queryFn: async () => ({}) },
	refreshAgents: vi.fn(),
}));

vi.mock("./CreateProjectAgentSheet", () => ({
	RequiredAgentField: () => <div data-testid="agent-field" />,
}));

vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: h.get,
		POST: h.post,
	},
	apiErrorCode: (error: { code?: string }) => error?.code,
	apiErrorMessage: (_e: unknown, fallback = "err") => fallback,
}));

vi.mock("../lib/telemetry", () => ({ captureRendererEvent: h.capture }));

import { TaskComposer } from "./TaskComposer";

function Wrap({ children }: { children: ReactNode }) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const task = () => screen.getByPlaceholderText(/Describe the change/i);

beforeEach(() => {
	h.get.mockImplementation(async (path: string) => {
		if (path.includes("/models")) {
			return {
				data: {
					agent: "codex",
					selectionMode: "text",
					models: [],
					allowCustom: true,
					refreshRecommended: false,
				},
			};
		}
		return { data: { status: "ok", project: { config: {} } } };
	});
});

afterEach(() => {
	h.get.mockReset();
	h.post.mockReset();
	h.capture.mockReset();
});

describe("TaskComposer", () => {
	it("emits busy state around an in-flight create and reports the new session", async () => {
		const onSubmittingChange = vi.fn();
		const onCreated = vi.fn();
		let resolveCreate!: (value: { data: { workerId: string } }) => void;
		h.post.mockReturnValueOnce(new Promise((resolve) => (resolveCreate = resolve)));

		render(
			<Wrap>
				<TaskComposer projectId="proj-1" onCreated={onCreated} onSubmittingChange={onSubmittingChange} />
			</Wrap>,
		);

		fireEvent.change(task(), { target: { value: "Do the thing" } });
		fireEvent.click(screen.getByText("Start task"));

		await waitFor(() => expect(onSubmittingChange).toHaveBeenLastCalledWith(true));
		expect(h.post).toHaveBeenCalledWith(
			"/api/v1/orchestrators/delegate",
			expect.objectContaining({
				body: expect.objectContaining({ projectId: "proj-1", brief: "Do the thing" }),
			}),
		);

		await act(async () => resolveCreate({ data: { workerId: "sess-1" } }));
		await waitFor(() => expect(onCreated).toHaveBeenCalledWith("sess-1"));
		await waitFor(() => expect(onSubmittingChange).toHaveBeenLastCalledWith(false));
	});

	it("clears busy state when a create rejects", async () => {
		const onSubmittingChange = vi.fn();
		h.post.mockRejectedValueOnce(new Error("nope"));

		render(
			<Wrap>
				<TaskComposer projectId="proj-1" onCreated={vi.fn()} onSubmittingChange={onSubmittingChange} />
			</Wrap>,
		);

		fireEvent.change(task(), { target: { value: "B" } });
		fireEvent.click(screen.getByText("Start task"));

		await waitFor(() => expect(screen.getByText("nope")).toBeInTheDocument());
		expect(onSubmittingChange).toHaveBeenLastCalledWith(false);
	});

	it("offers an explicit Terminal UI retry after Chat preflight fails", async () => {
		h.post
			.mockResolvedValueOnce({ error: { code: "CHAT_DRIVER_UNAVAILABLE" } })
			.mockResolvedValueOnce({ data: { workerId: "sess-tui" } });
		const onCreated = vi.fn();

		render(
			<Wrap>
				<TaskComposer projectId="proj-1" onCreated={onCreated} />
			</Wrap>,
		);
		fireEvent.change(task(), { target: { value: "Do the thing" } });
		fireEvent.click(screen.getByText("Start task"));

		const fallback = await screen.findByRole("button", { name: "Create as Terminal UI" });
		fireEvent.click(fallback);
		await waitFor(() => expect(onCreated).toHaveBeenCalledWith("sess-tui"));
		expect(h.post).toHaveBeenLastCalledWith(
			"/api/v1/orchestrators/delegate",
			expect.objectContaining({ body: expect.objectContaining({ mode: "tui" }) }),
		);
	});

	it("reports dirty then clears it on unmount", () => {
		const onDirtyChange = vi.fn();
		const { unmount } = render(
			<Wrap>
				<TaskComposer projectId="proj-1" onCreated={vi.fn()} onDirtyChange={onDirtyChange} />
			</Wrap>,
		);
		fireEvent.change(task(), { target: { value: "T" } });
		expect(onDirtyChange).toHaveBeenLastCalledWith(true);
		unmount();
		expect(onDirtyChange).toHaveBeenLastCalledWith(false);
	});

	it("uses the project worker model as the new task model default", async () => {
		h.get.mockImplementation(async (path: string) => {
			if (path.includes("/models")) {
				return {
					data: {
						agent: "codex",
						selectionMode: "text",
						models: [],
						allowCustom: true,
						refreshRecommended: false,
					},
				};
			}
			return {
				data: {
					status: "ok",
					project: {
						config: { worker: { agent: "codex", agentConfig: { model: "gpt-5" } } },
					},
				},
			};
		});
		h.post.mockResolvedValueOnce({ data: { workerId: "sess-2" } });

		render(
			<Wrap>
				<TaskComposer projectId="proj-1" onCreated={vi.fn()} />
			</Wrap>,
		);

		const model = await screen.findByDisplayValue("gpt-5");
		fireEvent.change(model, { target: { value: "gpt-5.1" } });
		fireEvent.change(task(), { target: { value: "Use the selected model" } });
		fireEvent.click(screen.getByText("Start task"));

		await waitFor(() =>
			expect(h.post).toHaveBeenCalledWith(
				"/api/v1/orchestrators/delegate",
				expect.objectContaining({
					body: expect.objectContaining({ model: "gpt-5.1" }),
				}),
			),
		);
	});
});
