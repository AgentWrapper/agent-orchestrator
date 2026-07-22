import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CloudWorkspaceSetup, normalizeGitHubRepository } from "./CloudWorkspaceSetup";

describe("CloudWorkspaceSetup", () => {
	it("collects only the three cloud inputs in order", async () => {
		const user = userEvent.setup();
		render(<CloudWorkspaceSetup />);

		expect(screen.getByLabelText("Daytona API key")).toBeInTheDocument();
		expect(screen.queryByLabelText("GitHub repository")).not.toBeInTheDocument();

		await user.type(screen.getByLabelText("Daytona API key"), "dtn_test");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		expect(screen.queryByLabelText("Daytona API key")).not.toBeInTheDocument();
		await user.type(screen.getByLabelText("GitHub repository"), "https://github.com/acme/widget.git");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		expect(screen.getByText(/acme\/widget/)).toBeInTheDocument();
		await user.type(screen.getByLabelText("GitHub personal access token"), "github_pat_test");
		await user.click(screen.getByRole("button", { name: "Continue to Codex login" }));

		expect(screen.getByRole("heading", { name: "Codex login is next" })).toBeInTheDocument();
		expect(screen.queryByLabelText("GitHub personal access token")).not.toBeInTheDocument();
		expect(screen.queryByLabelText(/git author/i)).not.toBeInTheDocument();
	});

	it("rejects repositories outside GitHub", async () => {
		const user = userEvent.setup();
		render(<CloudWorkspaceSetup />);

		await user.type(screen.getByLabelText("Daytona API key"), "dtn_test");
		await user.click(screen.getByRole("button", { name: "Continue" }));
		await user.type(screen.getByLabelText("GitHub repository"), "https://example.com/acme/widget");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		expect(screen.getByText("Enter a GitHub repository such as owner/repository.")).toBeInTheDocument();
	});
});

describe("normalizeGitHubRepository", () => {
	it("normalizes common GitHub repository formats", () => {
		expect(normalizeGitHubRepository("acme/widget")).toBe("acme/widget");
		expect(normalizeGitHubRepository("https://github.com/acme/widget.git")).toBe("acme/widget");
		expect(normalizeGitHubRepository("git@github.com:acme/widget.git")).toBe("acme/widget");
	});
});
