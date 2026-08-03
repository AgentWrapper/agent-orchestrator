import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ createTask: vi.fn() }));

vi.mock("../hooks/useCreateTask", () => ({ useCreateTask: () => h.createTask }));

vi.mock("../hooks/useAgentsQuery", () => ({
	agentsQueryKey: ["agents"],
	agentsQueryOptions: { queryKey: ["agents"], queryFn: async () => ({}) },
	refreshAgents: vi.fn(),
}));

vi.mock("./CreateProjectAgentSheet", () => ({
	RequiredAgentField: () => <div data-testid="agent-field" />,
}));

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: vi.fn(async () => ({ data: { status: "ok", project: { config: {} } } })) },
	apiErrorMessage: (_e: unknown, fallback = "err") => fallback,
}));

import { TaskComposer } from "./TaskComposer";

function Wrap({ children }: { children: ReactNode }) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const title = () => screen.getByPlaceholderText(/Fix WebGL/i);
const brief = () => screen.getByPlaceholderText(/Describe the change/i);

afterEach(() => {
	h.createTask.mockReset();
});

describe("TaskComposer", () => {
	it("emits busy state around an in-flight create and reports the new session", async () => {
		const onSubmittingChange = vi.fn();
		const onCreated = vi.fn();
		let resolveCreate!: (id: string) => void;
		h.createTask.mockReturnValueOnce(new Promise<string>((resolve) => (resolveCreate = resolve)));

		render(
			<Wrap>
				<TaskComposer projectId="proj-1" onCreated={onCreated} onSubmittingChange={onSubmittingChange} />
			</Wrap>,
		);

		fireEvent.change(title(), { target: { value: "Ship it" } });
		fireEvent.change(brief(), { target: { value: "Do the thing" } });
		fireEvent.click(screen.getByText("Start task"));

		await waitFor(() => expect(onSubmittingChange).toHaveBeenLastCalledWith(true));
		expect(h.createTask).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "proj-1", title: "Ship it", prompt: "Do the thing" }),
		);

		await act(async () => resolveCreate("sess-1"));
		await waitFor(() => expect(onCreated).toHaveBeenCalledWith("sess-1"));
		await waitFor(() => expect(onSubmittingChange).toHaveBeenLastCalledWith(false));
	});

	it("clears busy state when a create rejects", async () => {
		const onSubmittingChange = vi.fn();
		h.createTask.mockRejectedValueOnce(new Error("nope"));

		render(
			<Wrap>
				<TaskComposer projectId="proj-1" onCreated={vi.fn()} onSubmittingChange={onSubmittingChange} />
			</Wrap>,
		);

		fireEvent.change(title(), { target: { value: "T" } });
		fireEvent.change(brief(), { target: { value: "B" } });
		fireEvent.click(screen.getByText("Start task"));

		await waitFor(() => expect(screen.getByText("nope")).toBeInTheDocument());
		expect(onSubmittingChange).toHaveBeenLastCalledWith(false);
	});

	it("reports dirty then clears it on unmount", () => {
		const onDirtyChange = vi.fn();
		const { unmount } = render(
			<Wrap>
				<TaskComposer projectId="proj-1" onCreated={vi.fn()} onDirtyChange={onDirtyChange} />
			</Wrap>,
		);
		fireEvent.change(title(), { target: { value: "T" } });
		expect(onDirtyChange).toHaveBeenLastCalledWith(true);
		unmount();
		expect(onDirtyChange).toHaveBeenLastCalledWith(false);
	});
});
