import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { agentsQueryKey } from "../hooks/useAgentsQuery";
import { CreateProjectAgentSheet } from "./CreateProjectAgentSheet";

function renderSheet(onSubmit = vi.fn().mockResolvedValue(undefined)) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	queryClient.setQueryData(agentsQueryKey, {
		supported: [
			{ id: "claude-code", label: "claude-code" },
			{ id: "codex", label: "codex" },
		],
		installed: [
			{ id: "claude-code", label: "claude-code", authStatus: "authorized" },
			{ id: "codex", label: "codex", authStatus: "authorized" },
		],
		authorized: [
			{ id: "claude-code", label: "claude-code", authStatus: "authorized" },
			{ id: "codex", label: "codex", authStatus: "authorized" },
		],
	});
	render(
		<QueryClientProvider client={queryClient}>
			<CreateProjectAgentSheet
				isCreating={false}
				onOpenChange={() => undefined}
				onSubmit={onSubmit}
				open={true}
				path="/repo/new-project"
			/>
		</QueryClientProvider>,
	);
	return onSubmit;
}

async function chooseOption(trigger: HTMLElement, optionName: string) {
	await userEvent.click(trigger);
	await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

describe("CreateProjectAgentSheet", () => {
	it("creates without intake when the toggle is left off", async () => {
		const onSubmit = renderSheet();
		await chooseOption(screen.getByLabelText("Worker agent"), "claude-code");
		await chooseOption(screen.getByLabelText("Orchestrator agent"), "codex");

		await userEvent.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit).toHaveBeenCalledWith({
			workerAgent: "claude-code",
			orchestratorAgent: "codex",
			trackerIntake: undefined,
		});
	});

	it("blocks submit when intake is enabled with no assignee, then passes the intake payload once one is set", async () => {
		const onSubmit = renderSheet();
		await chooseOption(screen.getByLabelText("Worker agent"), "claude-code");
		await chooseOption(screen.getByLabelText("Orchestrator agent"), "codex");

		await userEvent.click(screen.getByLabelText("Enable issue intake"));
		// Enabled with no eligibility rule → submit stays disabled (compact sheet
		// carries no inline guard prose; gating is the disabled button).
		expect(screen.getByRole("button", { name: "Create and start" })).toBeDisabled();

		await userEvent.type(screen.getByLabelText("Assignee"), "octocat");
		await userEvent.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit).toHaveBeenCalledWith({
			workerAgent: "claude-code",
			orchestratorAgent: "codex",
			trackerIntake: { enabled: true, provider: "github", assignee: "octocat" },
		});
	});

	it("keeps the create sheet minimal: info tooltip instead of prose, no repo row or credential hint", async () => {
		renderSheet();
		// Info affordance is present even before enabling; the descriptive prose is not.
		expect(screen.getByLabelText("What does enabling issue intake do?")).toBeInTheDocument();
		expect(screen.queryByText(/Auto-spawn worker sessions from matching tracker issues/)).not.toBeInTheDocument();

		await userEvent.click(screen.getByLabelText("Enable issue intake"));
		expect(screen.queryByText("Repository")).not.toBeInTheDocument();
		expect(screen.queryByText(/Reads credentials from/)).not.toBeInTheDocument();
	});
});
