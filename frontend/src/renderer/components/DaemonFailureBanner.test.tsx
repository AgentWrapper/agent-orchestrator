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

	it.each([
		{ code: "not_ready" as const, title: "AO daemon is not ready yet" },
		{ code: "port_unconfirmed" as const, title: "AO daemon is not ready yet" },
		{ code: "not_configured" as const, title: "AO daemon is not configured" },
		{ code: "daemon_unreachable" as const, title: "AO daemon is unreachable" },
		{ code: "identity_mismatch" as const, title: "AO daemon identity check failed" },
		{ code: "binary_missing" as const, title: "AO daemon binary is missing" },
		{ code: "spawn_failed" as const, title: "AO daemon failed to start" },
		{ code: "exited" as const, title: "AO daemon failed to start" },
	])("uses a status-appropriate heading for $code", ({ code, title }) => {
		render(<DaemonFailureBanner status={{ state: "error", code }} />);

		expect(screen.getByRole("alert")).toHaveTextContent(title);
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
