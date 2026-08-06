import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionTopbarHost, SessionTopbarPortal, SessionTopbarProvider } from "./SessionTopbarPortal";

describe("SessionTopbarPortal", () => {
	it("renders portal content into the registered host", () => {
		render(
			<SessionTopbarProvider>
				<SessionTopbarHost data-testid="session-topbar-host" />
				<SessionTopbarPortal>
					<span>session controls</span>
				</SessionTopbarPortal>
			</SessionTopbarProvider>,
		);

		expect(screen.getByTestId("session-topbar-host")).toHaveTextContent("session controls");
	});
});
