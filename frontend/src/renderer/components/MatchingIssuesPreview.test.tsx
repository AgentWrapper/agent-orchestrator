import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MatchingIssuesPreview } from "./MatchingIssuesPreview";

const { postMock } = vi.hoisted(() => ({
	postMock: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: {
		POST: postMock,
	},
	apiErrorMessage: () => "Request failed",
}));

function renderPreview() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
		},
	});
	render(
		<QueryClientProvider client={queryClient}>
			<MatchingIssuesPreview projectId="proj-1" labels={[]} />
		</QueryClientProvider>,
	);
}

describe("MatchingIssuesPreview", () => {
	it("keeps the loading animation inside the fixed count badge", async () => {
		postMock.mockReturnValue(new Promise(() => undefined));

		renderPreview();

		const badge = await screen.findByRole("status", { name: "Checking matching open issues" });
		expect(badge).toHaveClass("h-6");
		expect(badge).toHaveClass("min-w-6");
		expect(badge).toHaveClass("leading-none");
		expect(badge.querySelector(".animate-spin")).not.toBeNull();
		expect(screen.queryByText("Checking…")).not.toBeInTheDocument();
	});

	it("renders the resolved count in the same stable badge", async () => {
		postMock.mockResolvedValue({ data: { count: 12 }, error: undefined });

		renderPreview();

		const badge = await screen.findByText("12");
		expect(badge).toHaveClass("h-6");
		expect(badge).toHaveClass("min-w-6");
		expect(badge).toHaveClass("leading-none");
	});
});
