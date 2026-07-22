import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DaemonFailureBanner } from "./DaemonFailureBanner";

describe("DaemonFailureBanner", () => {
	it("shows the daemon failure message, code, and actionable hint", () => {
		render(
			<DaemonFailureBanner
				status={{
					state: "error",
					code: "exited",
					message: "AO daemon exited with code 1",
				}}
			/>,
		);

		expect(screen.getByRole("alert")).toHaveTextContent("AO daemon failed to start");
		expect(screen.getByRole("alert")).toHaveTextContent("AO daemon exited with code 1");
		expect(screen.getByRole("alert")).toHaveTextContent("Check the terminal where you ran npm run dev");
		expect(screen.getByText("exited")).toBeInTheDocument();
	});

	it("renders nothing while the daemon is not in an error state", () => {
		const { container } = render(<DaemonFailureBanner status={{ state: "starting" }} />);

		expect(container).toBeEmptyDOMElement();
	});
});
