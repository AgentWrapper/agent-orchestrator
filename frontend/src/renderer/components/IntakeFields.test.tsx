import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRendererI18n } from "../i18n";
import { buildIntake, deriveProviderRepo, IntakeFields, type IntakeForm } from "./IntakeFields";

afterEach(async () => {
	await initializeRendererI18n("en");
});

describe("IntakeFields", () => {
	it("switches application copy immediately without changing repository or filter values", async () => {
		function Harness() {
			const [form, setForm] = useState<IntakeForm>({
				enabled: true,
				provider: "gitlab",
				repo: "group/subgroup/api",
				assignee: "alice",
				labels: "ready, backend",
			});
			return (
				<IntakeFields
					form={form}
					onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
					repoPreview={{
						provider: "gitlab",
						value: "group/subgroup/api",
						href: "https://gitlab.example.com/group/subgroup/api",
					}}
				/>
			);
		}
		render(<Harness />);
		await userEvent.clear(screen.getByLabelText("Assignee"));
		await userEvent.type(screen.getByLabelText("Assignee"), "chenzegong");

		await act(async () => {
			await initializeRendererI18n("zh-CN");
		});

		expect(screen.getByLabelText("启用议题接入")).toBeChecked();
		expect(screen.getByLabelText("负责人")).toHaveValue("chenzegong");
		expect(screen.getByLabelText("标签")).toHaveValue("ready, backend");
		expect(screen.getByRole("link", { name: "group/subgroup/api" })).toHaveAttribute(
			"href",
			"https://gitlab.example.com/group/subgroup/api",
		);
		expect(screen.getByText("自动从匹配的跟踪器议题启动工作会话。")).toBeInTheDocument();
	});

	it("derives provider-native repositories including GitLab subgroups", () => {
		expect(deriveProviderRepo("git@github.com:acme/web.git", "github")).toBe("acme/web");
		expect(deriveProviderRepo("git@gitlab.example.com:group/subgroup/api.git", "gitlab")).toBe(
			"group/subgroup/api",
		);
	});

	it("builds inherited GitLab intake filters", () => {
		expect(
			buildIntake({ enabled: true, provider: "gitlab", repo: "", assignee: "alice", labels: "ready, backend" }),
		).toEqual({
			enabled: true,
			provider: "gitlab",
			assignee: "alice",
			labels: ["ready", "backend"],
		});
	});

	it("renders a GitLab repository preview without a GitHub URL", () => {
		render(
			<IntakeFields
				form={{ enabled: true, provider: "gitlab", repo: "", assignee: "alice", labels: "" }}
				onChange={() => undefined}
				repoPreview={{
					provider: "gitlab",
					value: "group/subgroup/api",
					href: "https://gitlab.example.com/group/subgroup/api",
				}}
			/>,
		);

		expect(screen.getByRole("link", { name: "group/subgroup/api" })).toHaveAttribute(
			"href",
			"https://gitlab.example.com/group/subgroup/api",
		);
	});
});
