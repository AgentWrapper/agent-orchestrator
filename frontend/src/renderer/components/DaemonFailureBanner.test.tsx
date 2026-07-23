import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonFailureBanner } from "./DaemonFailureBanner";

describe("DaemonFailureBanner", () => {
	afterEach(() => vi.useRealTimers());

	it("shows the daemon failure message, code, and actionable hint", () => {
		render(
			<DaemonFailureBanner
				status={{
					state: "stopped",
					code: "exited",
					message: "AO daemon exited with code 1",
					details: "go: go.mod requires go >= 1.25.7",
				}}
			/>,
		);

		expect(screen.getByRole("alert")).toHaveTextContent("AO daemon failed to start");
		expect(screen.getByRole("alert")).toHaveTextContent("AO daemon exited with code 1");
		expect(screen.getByText("exited")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Show details" }));
		expect(screen.getByText("go: go.mod requires go >= 1.25.7")).toBeInTheDocument();
	});

	it("resets copy feedback when failure details change", async () => {
		const { rerender } = render(
			<DaemonFailureBanner status={{ state: "stopped", code: "exited", details: "first failure" }} />,
		);

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
		});
		expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

		rerender(<DaemonFailureBanner status={{ state: "stopped", code: "exited", details: "second failure" }} />);

		expect(screen.getByRole("button", { name: "Copy details" })).toBeInTheDocument();
	});

	it("resets copy feedback after two seconds", async () => {
		vi.useFakeTimers();
		render(<DaemonFailureBanner status={{ state: "stopped", code: "exited", details: "failure" }} />);

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
		});
		expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

		act(() => vi.advanceTimersByTime(2_000));

		expect(screen.getByRole("button", { name: "Copy details" })).toBeInTheDocument();
	});

	it("renders nothing while the daemon is not in an error state", () => {
		const { container } = render(<DaemonFailureBanner status={{ state: "starting" }} />);

		expect(container).toBeEmptyDOMElement();
	});
});
