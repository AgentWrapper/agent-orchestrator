import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock },
	apiErrorMessage: () => "Request failed",
}));

import { LabelPicker } from "./LabelPicker";

function TestPicker({ initialLabels = [] }: { initialLabels?: string[] }) {
	const [labels, setLabels] = useState<string[]>(initialLabels);
	return <LabelPicker projectId="demo" value={labels} onChange={setLabels} />;
}

function renderPicker(initialLabels: string[] = []) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<TestPicker initialLabels={initialLabels} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	getMock.mockReset();
	getMock.mockResolvedValue({
		data: {
			labels: [
				{ name: "bug", color: "d73a4a", description: "Something is broken" },
				{ name: "ready for agent", color: "4d8dff", description: "Ready for implementation" },
			],
		},
		error: undefined,
	});
});

it("searches and multi-selects repository labels without closing", async () => {
	renderPicker();
	await userEvent.click(screen.getByRole("button", { name: "Labels" }));

	const search = await screen.findByPlaceholderText("Search labels…");
	await userEvent.type(search, "ready");
	expect(screen.queryByText("bug")).not.toBeInTheDocument();
	await userEvent.click(screen.getByRole("option", { name: /ready for agent/i }));
	expect(search).toBeVisible();

	await userEvent.clear(search);
	await userEvent.click(screen.getByRole("option", { name: /bug/i }));
	await userEvent.keyboard("{Escape}");
	expect(screen.getByRole("button", { name: "Labels" })).toHaveTextContent("2 labels selected");
});

it("requests an immediate refresh", async () => {
	renderPicker();
	await userEvent.click(screen.getByRole("button", { name: "Labels" }));
	await screen.findByText("bug");
	await userEvent.click(screen.getByRole("button", { name: "Refresh labels" }));
	expect(getMock).toHaveBeenLastCalledWith(
		"/api/v1/projects/{id}/tracker-intake/github/labels",
		expect.objectContaining({ params: { path: { id: "demo" }, query: { refresh: true } } }),
	);
});

it("does not mark selected labels unavailable while the catalog loads", async () => {
	getMock.mockReturnValue(new Promise(() => {}));
	renderPicker(["bug"]);
	await userEvent.click(screen.getByRole("button", { name: "Labels" }));
	expect(screen.getByText("Loading labels…")).toBeInTheDocument();
	expect(screen.queryByText("No longer available in this repository")).not.toBeInTheDocument();
});
