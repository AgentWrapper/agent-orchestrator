import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { buildIntake, DEFAULT_OPT_OUT_LABELS, IntakeFields, type IntakeForm } from "./IntakeFields";

// A tiny controlled harness so the editor's state updates are exercised the way
// the real forms drive it.
function Harness({ initial, compact = false }: { initial: IntakeForm; compact?: boolean }) {
	const [form, setForm] = useState<IntakeForm>(initial);
	return (
		<>
			<IntakeFields form={form} onChange={(patch) => setForm((f) => ({ ...f, ...patch }))} compact={compact} />
			<output data-testid="labels">{form.optOutLabels.join(",")}</output>
		</>
	);
}

const enabled = (optOutLabels: string[]): IntakeForm => ({
	enabled: true,
	repo: "",
	assignee: "",
	maxConcurrent: "",
	optOutLabels,
});

describe("IntakeFields opt-out label editor", () => {
	it("adds a label on Enter and removes it via its chip", async () => {
		render(<Harness initial={enabled(["no-ao"])} />);

		await userEvent.type(screen.getByLabelText("Add opt-out label"), "wontfix{Enter}");
		expect(screen.getByTestId("labels")).toHaveTextContent("no-ao,wontfix");

		await userEvent.click(screen.getByRole("button", { name: "Remove no-ao" }));
		expect(screen.getByTestId("labels")).toHaveTextContent("wontfix");
	});

	it("ignores case-insensitive and blank duplicates", async () => {
		render(<Harness initial={enabled(["charter"])} />);

		await userEvent.type(screen.getByLabelText("Add opt-out label"), "CHARTER{Enter}");
		await userEvent.type(screen.getByLabelText("Add opt-out label"), "   {Enter}");
		expect(screen.getByTestId("labels")).toHaveTextContent("charter");
	});

	it("does not flush a half-typed draft when a chip is removed", async () => {
		render(<Harness initial={enabled(["no-ao", "deferred"])} />);

		await userEvent.type(screen.getByLabelText("Add opt-out label"), "wontf");
		await userEvent.click(screen.getByRole("button", { name: "Remove deferred" }));

		// The half-typed "wontf" must NOT be committed by the remove interaction.
		expect(screen.getByTestId("labels")).toHaveTextContent("no-ao");
		expect(screen.getByTestId("labels")).not.toHaveTextContent("wontf");
	});

	it("explains that the default labels apply when the list is empty", () => {
		render(<Harness initial={enabled([])} />);
		expect(screen.getByText(/default opt-out labels/i)).toBeInTheDocument();
		// The add input is still available so the user can re-populate the list.
		expect(screen.getByLabelText("Add opt-out label")).toBeInTheDocument();
	});

	it("hides the editor in compact mode", () => {
		render(<Harness initial={enabled([...DEFAULT_OPT_OUT_LABELS])} compact />);
		expect(screen.queryByLabelText("Add opt-out label")).not.toBeInTheDocument();
	});
});

describe("buildIntake", () => {
	it("preserves base fields the form does not own", () => {
		const base = { enabled: true, provider: "github" as const, maxConcurrent: 5, labels: ["ready"] };
		const out = buildIntake(enabled(["no-ao"]), base);
		expect(out).toEqual({
			enabled: true,
			provider: "github",
			labels: ["ready"],
			excludeLabels: ["no-ao"],
		});
	});

	it("serializes an edited max concurrency", () => {
		const out = buildIntake({ ...enabled(["no-ao"]), maxConcurrent: "7" });
		expect(out?.maxConcurrent).toBe(7);
	});

	it("omits excludeLabels when intake is disabled", () => {
		const out = buildIntake({ enabled: false, repo: "", assignee: "", maxConcurrent: "", optOutLabels: ["no-ao"] });
		expect(out).toBeUndefined();
	});

	it("drops the whole config (no stale base fields) when intake is disabled", () => {
		// Disabling intake must not persist a base's maxConcurrent/labels behind a
		// disabled flag — the config is dropped entirely.
		const base = { enabled: true, provider: "github" as const, maxConcurrent: 4, labels: ["ready"] };
		const out = buildIntake({ enabled: false, repo: "", assignee: "", maxConcurrent: "", optOutLabels: [] }, base);
		expect(out).toBeUndefined();
	});

	it("can serialize an explicit disable sentinel while preserving hidden base fields", () => {
		const base = { enabled: true, provider: "github" as const, maxConcurrent: 4, labels: ["ready"] };
		const out = buildIntake({ enabled: false, repo: "", assignee: "", maxConcurrent: "", optOutLabels: [] }, base, {
			explicitDisable: true,
		});
		expect(out).toEqual({ enabled: false, provider: "github", maxConcurrent: 4, labels: ["ready"] });
	});

	it("serializes a disabled populated base even when the daemon omitted enabled false", () => {
		const base = { provider: "github" as const, maxConcurrent: 4, labels: ["ready"] };
		const out = buildIntake({ enabled: false, repo: "", assignee: "", maxConcurrent: "", optOutLabels: [] }, base);
		expect(out).toEqual({ enabled: false, provider: "github", maxConcurrent: 4, labels: ["ready"] });
	});

	it("does not fabricate a disable sentinel for a never-configured base", () => {
		const out = buildIntake({ enabled: false, repo: "", assignee: "", maxConcurrent: "", optOutLabels: [] }, {});
		expect(out).toBeUndefined();
	});
});
