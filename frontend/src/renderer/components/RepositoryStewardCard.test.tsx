import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryStewardCard } from "./RepositoryStewardCard";

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: (...args: unknown[]) => getMock(...args),
		POST: (...args: unknown[]) => postMock(...args),
	},
	apiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

const protectedStatus = {
	agent: "Repository steward",
	enabled: true,
	state: "protected",
	intervalSeconds: 60,
	lastRunAt: "2026-07-14T12:00:00Z",
	nextRunAt: "2026-07-14T12:01:00Z",
	repositories: [
		{
			name: "Main checkout",
			branch: "main",
			dirty: true,
			localRef: "refs/ao/recovery/mer/main",
			localSha: "abc123",
			remoteRef: "refs/heads/ao-recovery/mer/main",
			remoteState: "synced",
			lastCheckpointAt: "2026-07-14T12:00:00Z",
		},
	],
} as const;

function renderCard() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<RepositoryStewardCard projectId="mer" />
		</QueryClientProvider>,
	);
}

describe("RepositoryStewardCard", () => {
	beforeEach(() => {
		getMock.mockReset().mockResolvedValue({ data: { repositorySteward: protectedStatus }, error: undefined });
		postMock.mockReset().mockResolvedValue({ data: { repositorySteward: protectedStatus }, error: undefined });
	});

	it("shows a separate always-on agent and GitHub recovery health", async () => {
		renderCard();
		expect(await screen.findByText("Always on")).toBeInTheDocument();
		expect(screen.getByText("Repository steward")).toBeInTheDocument();
		expect(screen.getByText("GitHub synced")).toBeInTheDocument();
		expect(screen.getByText("1 dirty protected")).toBeInTheDocument();
		expect(screen.getByText("Recovery details")).toBeInTheDocument();
		expect(screen.getByText("refs/ao/recovery/mer/main")).toBeInTheDocument();
	});

	it("creates a checkpoint without opening a terminal", async () => {
		const user = userEvent.setup();
		renderCard();
		await screen.findByText("Always on");
		await user.click(screen.getByRole("button", { name: "Create recovery checkpoint now" }));
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/v1/projects/{projectId}/repository-steward/checkpoint", {
			params: { path: { projectId: "mer" } },
		});
	});
});
