import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { agentsQueryKey } from "../hooks/useAgentsQuery";
import { modelAvailabilityQueryKey } from "../hooks/useModelAvailabilityQuery";
import { buildProjectAgentConfig, CreateProjectAgentSheet } from "./CreateProjectAgentSheet";

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
	queryClient.setQueryData(modelAvailabilityQueryKey, {
		checkedAt: "2026-07-10T12:00:00Z",
		harnesses: [
			{
				id: "claude-code",
				label: "Claude Code",
				catalogSource: "known-set",
				models: [{ model: "opus", status: "unreachable", reason: "400 model not available" }],
			},
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

describe("buildProjectAgentConfig", () => {
	it("assembles the standard baseline (bypass-permissions + opus) sent to the create API", () => {
		expect(buildProjectAgentConfig("bypass-permissions", "opus")).toEqual({
			permissions: "bypass-permissions",
			model: "opus",
		});
	});

	it("trims the model and omits it when blank", () => {
		expect(buildProjectAgentConfig("bypass-permissions", "  claude-opus-4-5  ")).toEqual({
			permissions: "bypass-permissions",
			model: "claude-opus-4-5",
		});
		expect(buildProjectAgentConfig("bypass-permissions", "   ")).toEqual({ permissions: "bypass-permissions" });
	});

	it("omits the permission mode when blank", () => {
		expect(buildProjectAgentConfig("", "opus")).toEqual({ model: "opus" });
	});

	it("returns undefined when nothing is set, so the daemon persists no agentConfig", () => {
		expect(buildProjectAgentConfig("", "  ")).toBeUndefined();
	});
});

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
			permissions: "bypass-permissions",
			model: "opus",
			trackerIntake: undefined,
		});
	});

	it("pre-fills the standard baseline (bypass-permissions + opus) and lets it be adjusted before creating", async () => {
		const onSubmit = renderSheet();
		// Defaults are visible in the form, not a hidden bare default.
		expect(screen.getByLabelText("Permission mode")).toHaveTextContent("Bypass permissions");
		expect(screen.getByLabelText("Model")).toHaveValue("opus");
		expect(screen.getByText(/unreachable: 400 model not available/)).toBeInTheDocument();

		await chooseOption(screen.getByLabelText("Worker agent"), "claude-code");
		await chooseOption(screen.getByLabelText("Orchestrator agent"), "claude-code");
		// Override the pre-filled defaults to prove they are editable.
		await chooseOption(screen.getByLabelText("Permission mode"), "Accept edits");
		const modelInput = screen.getByLabelText("Model");
		await userEvent.clear(modelInput);
		await userEvent.type(modelInput, "  claude-opus-4-5  ");

		await userEvent.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit).toHaveBeenCalledWith({
			workerAgent: "claude-code",
			orchestratorAgent: "claude-code",
			permissions: "accept-edits",
			model: "claude-opus-4-5",
			trackerIntake: undefined,
		});
	});

	it("allows submit with intake enabled and no assignee (opt-out-by-default)", async () => {
		const onSubmit = renderSheet();
		await chooseOption(screen.getByLabelText("Worker agent"), "claude-code");
		await chooseOption(screen.getByLabelText("Orchestrator agent"), "codex");

		await userEvent.click(screen.getByLabelText("Enable issue intake"));
		// Issue #80: an assignee is no longer required — intake is opt-out-by-default,
		// so the button is enabled with intake on and no assignee. The compact sheet
		// leaves excludeLabels unset; the daemon materializes the default taxonomy.
		expect(screen.getByRole("button", { name: "Create and start" })).toBeEnabled();

		await userEvent.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit).toHaveBeenCalledWith({
			workerAgent: "claude-code",
			orchestratorAgent: "codex",
			permissions: "bypass-permissions",
			model: "opus",
			trackerIntake: { enabled: true, provider: "github" },
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
