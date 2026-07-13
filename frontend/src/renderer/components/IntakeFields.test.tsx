import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { buildIntake, IntakeFields, type IntakeForm, intakeIsValid } from "./IntakeFields";

function Harness({ initial }: { initial: IntakeForm }) {
	const [form, setForm] = useState<IntakeForm>(initial);
	return <IntakeFields form={form} onChange={(patch) => setForm((current) => ({ ...current, ...patch }))} />;
}

const enabled: IntakeForm = { enabled: true, repo: "", assignee: "*", maxConcurrent: "2" };

describe("IntakeFields", () => {
	it("shows assignment and finite-cap controls without label admission controls", () => {
		render(<Harness initial={enabled} />);
		expect(screen.getByLabelText("Authorized assignee")).toHaveValue("*");
		expect(screen.getByLabelText("Maximum concurrent workers")).toHaveValue(2);
		expect(screen.getByText(/assignment authorizes execution/i)).toBeInTheDocument();
		expect(screen.queryByText(/opt-out labels/i)).not.toBeInTheDocument();
	});
});

describe("intakeIsValid", () => {
	it("requires an assignee other than none and a positive integer cap", () => {
		expect(intakeIsValid(enabled)).toBe(true);
		expect(intakeIsValid({ ...enabled, assignee: "" })).toBe(false);
		expect(intakeIsValid({ ...enabled, assignee: "none" })).toBe(false);
		expect(intakeIsValid({ ...enabled, maxConcurrent: "0" })).toBe(false);
		expect(intakeIsValid({ ...enabled, maxConcurrent: "1.5" })).toBe(false);
	});
});

describe("buildIntake", () => {
	it("serializes the sole assignment gate and strips legacy label admission fields", () => {
		const out = buildIntake(enabled, {
			enabled: true,
			provider: "github",
			labels: ["ready"],
			excludeLabels: ["no-ao"],
		});
		expect(out).toEqual({ enabled: true, provider: "github", assignee: "*", maxConcurrent: 2 });
	});

	it("refuses to emit unsafe enabled intake", () => {
		expect(() => buildIntake({ ...enabled, assignee: "" })).toThrow(/requires an assignee/i);
		expect(() => buildIntake({ ...enabled, maxConcurrent: "0" })).toThrow(/positive finite concurrency cap/i);
	});

	it("can serialize an explicit disable sentinel", () => {
		expect(
			buildIntake(
				{ ...enabled, enabled: false },
				{ enabled: true, provider: "github", labels: ["ready"], excludeLabels: ["no-ao"] },
				{ explicitDisable: true },
			),
		).toEqual({
			enabled: false,
			provider: "github",
		});
	});
});
