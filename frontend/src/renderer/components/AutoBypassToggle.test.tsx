import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutoBypassToggle } from "./AutoBypassToggle";

const getMock = vi.fn();
const putMock = vi.fn();

vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: (...args: unknown[]) => getMock(...args),
		PUT: (...args: unknown[]) => putMock(...args),
	},
	apiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

function renderToggle() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={queryClient}>
			<AutoBypassToggle projectId="proj-1" />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	getMock.mockReset();
	putMock.mockReset();
	getMock.mockResolvedValue({
		data: {
			status: "ok",
			project: {
				id: "proj-1",
				name: "My project",
				path: "/repo",
				kind: "single_repo",
				defaultBranch: "main",
				repo: "",
				config: {
					defaultBranch: "main",
					worker: { agent: "codex", agentConfig: { model: "gpt-5.5" } },
				},
			},
		},
		error: undefined,
	});
	putMock.mockResolvedValue({ data: { ok: true }, error: undefined });
});

describe("AutoBypassToggle", () => {
	it("persists a reversible complete-access policy for every subagent", async () => {
		const user = userEvent.setup();
		renderToggle();
		const toggle = await screen.findByRole("button", { name: "Toggle bypass permission mode for all subagents" });
		await waitFor(() => expect(toggle).toBeEnabled());
		expect(toggle).toHaveAttribute("aria-pressed", "false");
		expect(toggle).toHaveAttribute("title", "Subagents use project and task permission settings");

		await user.click(toggle);
		await waitFor(() =>
			expect(putMock).toHaveBeenCalledWith("/api/v1/projects/{id}/config", {
				params: { path: { id: "proj-1" } },
				body: {
					config: {
						defaultBranch: "main",
						worker: { agent: "codex", agentConfig: { model: "gpt-5.5" } },
						autoBypassWorkerPermissions: true,
					},
				},
			}),
		);
		expect(toggle).toHaveAttribute("aria-pressed", "true");
		expect(toggle).toHaveAttribute("title", "All subagents have complete access");

		await user.click(toggle);
		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(2));
		expect(putMock.mock.calls[1]?.[1]).toMatchObject({
			body: { config: { autoBypassWorkerPermissions: false } },
		});
		expect(toggle).toHaveAttribute("aria-pressed", "false");
	});
});
