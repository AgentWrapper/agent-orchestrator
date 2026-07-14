import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { agentsQueryKey } from "../hooks/useAgentsQuery";
import { modelAvailabilityQueryKey } from "../hooks/useModelAvailabilityQuery";
import { buildProjectAgentConfig, CreateProjectAgentSheet, RequiredAgentField } from "./CreateProjectAgentSheet";

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
				kind="single_repo"
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
	it("uses the compact trigger size for agent fields", () => {
		render(
			<RequiredAgentField
				id="agent"
				label="Agent"
				onChange={() => undefined}
				placeholder="Project default"
				value="claude-code"
			/>,
		);

		expect(screen.getByLabelText("Agent")).toHaveAttribute("data-size", "sm");
	});

	it("caps the agent menu height with a theme token", async () => {
		render(
			<RequiredAgentField id="agent" label="Agent" onChange={() => undefined} placeholder="Project default" value="" />,
		);

		await userEvent.click(screen.getByLabelText("Agent"));

		expect(await screen.findByRole("listbox")).toHaveClass("max-h-select-menu-max!");
	});

	it("creates without intake when the toggle is left off", async () => {
		const onSubmit = renderSheet();
		await chooseOption(screen.getByLabelText("Worker agent"), "claude-code");
		await chooseOption(screen.getByLabelText("Orchestrator agent"), "codex");

		await userEvent.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit).toHaveBeenCalledWith({
			workerAgent: "claude-code",
			orchestratorAgent: "codex",
			permissions: "",
			model: "",
			trackerIntake: undefined,
		});
	});

	it("pre-fills nothing: the daemon owns the baseline, so only explicit choices are sent", async () => {
		const onSubmit = renderSheet();
		// The standard baseline (bypass-permissions + a per-harness model pin) is applied
		// by the daemon at registration, on every creation path. Pre-filling it here is
		// what made a UI-created project runnable and an `ao project add` one deadlock.
		expect(screen.getByLabelText("Permission mode")).not.toHaveTextContent("Bypass permissions");
		expect(screen.getByLabelText("Model")).toHaveValue("");

		await chooseOption(screen.getByLabelText("Worker agent"), "claude-code");
		await chooseOption(screen.getByLabelText("Orchestrator agent"), "claude-code");

		await userEvent.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit).toHaveBeenCalledWith({
			workerAgent: "claude-code",
			orchestratorAgent: "claude-code",
			permissions: "",
			model: "",
			trackerIntake: undefined,
		});
	});

	it("sends an explicit operator choice, overriding the daemon default", async () => {
		const onSubmit = renderSheet();
		await chooseOption(screen.getByLabelText("Worker agent"), "claude-code");
		await chooseOption(screen.getByLabelText("Orchestrator agent"), "claude-code");
		await chooseOption(screen.getByLabelText("Permission mode"), "Accept edits");
		const modelInput = screen.getByLabelText("Model");
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

	it("submits safe assignment-gated intake defaults", async () => {
		const onSubmit = renderSheet();
		await chooseOption(screen.getByLabelText("Worker agent"), "claude-code");
		await chooseOption(screen.getByLabelText("Orchestrator agent"), "codex");

		await userEvent.click(screen.getByLabelText("Enable issue intake"));
		expect(screen.getByRole("button", { name: "Create and start" })).toBeEnabled();

		await userEvent.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit).toHaveBeenCalledWith({
			workerAgent: "claude-code",
			orchestratorAgent: "codex",
			permissions: "",
			model: "",
			trackerIntake: { enabled: true, provider: "github", assignee: "*", maxConcurrent: 2 },
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
