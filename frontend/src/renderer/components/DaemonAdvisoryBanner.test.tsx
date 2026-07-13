// Cycle-4 1b (#293): the takeover fails CLOSED — an unverifiable port holder is
// never signalled — and until now it also failed SILENTLY. The advisory naming the
// PID to stop was written into DaemonStatus.message and then dropped: nothing in
// the renderer displayed `message`, so a user on Windows (or with an unreadable
// /proc) saw only "daemon stopped" while a wedged daemon sat on the port. These
// tests pin the message to a surface the user actually sees.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DaemonAdvisoryBanner } from "./DaemonAdvisoryBanner";

const advisory =
	"A process (pid 4242) may still be holding the AO daemon port 3001, but it could not be verified as an AO " +
	"daemon, so AO did not stop it. Stop pid 4242 yourself, then start the daemon again.";

describe("DaemonAdvisoryBanner", () => {
	it("shows the refusal advisory the supervisor attached to a stopped daemon", () => {
		render(
			<DaemonAdvisoryBanner
				status={{ state: "stopped", message: `Daemon exited with code 1 ${advisory}`, code: "exited" }}
			/>,
		);
		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent("Daemon exited with code 1");
		expect(alert).toHaveTextContent("pid 4242");
		expect(alert).toHaveTextContent("port 3001");
		expect(alert).toHaveTextContent("Stop pid 4242 yourself");
	});

	it("shows a daemon error message", () => {
		render(<DaemonAdvisoryBanner status={{ state: "error", message: "spawn ao ENOENT", code: "spawn_failed" }} />);
		expect(screen.getByRole("alert")).toHaveTextContent("spawn ao ENOENT");
	});

	it("renders nothing for a healthy daemon that has nothing to say", () => {
		const { container } = render(<DaemonAdvisoryBanner status={{ state: "ready", port: 3001 }} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing for a message-less stopped daemon (an ordinary user stop)", () => {
		const { container } = render(<DaemonAdvisoryBanner status={{ state: "stopped" }} />);
		expect(container).toBeEmptyDOMElement();
	});
});
