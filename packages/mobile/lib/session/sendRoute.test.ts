import { describe, expect, it } from "vitest";
import { AWAITING_DECISION, routeForSend, shouldRetryOnTerminal, terminalPayload } from "./sendRoute";

describe("shouldRetryOnTerminal", () => {
	it("retries when the daemon says the session is paused on a decision", () => {
		expect(shouldRetryOnTerminal({ status: 409, code: AWAITING_DECISION })).toBe(true);
	});

	// The whole safety argument for auto-routing rests on this list. A dead
	// session has no PTY, so a "successful" write would swallow the user's text
	// and hide the real error behind a fake success.
	it("does NOT retry when there is no live PTY to write to", () => {
		for (const code of ["SESSION_TERMINATED", "AGENT_EXITED", "SESSION_NOT_FOUND", "SESSION_NOT_RESTORABLE"]) {
			expect(shouldRetryOnTerminal({ status: 409, code })).toBe(false);
		}
	});

	it("does not retry on auth, rate limiting, or an unrecognised failure", () => {
		expect(shouldRetryOnTerminal({ status: 401 })).toBe(false);
		expect(shouldRetryOnTerminal({ status: 429 })).toBe(false);
		expect(shouldRetryOnTerminal({ status: 500, code: "INTERNAL" })).toBe(false);
		expect(shouldRetryOnTerminal(null)).toBe(false);
		expect(shouldRetryOnTerminal(undefined)).toBe(false);
	});

	// A plain network Error carries no code, so it can never be mistaken for the
	// one condition we act on.
	it("does not retry when the server was never reached", () => {
		expect(shouldRetryOnTerminal({} as { code?: string })).toBe(false);
	});

	// Matching on the code, not the prose: the daemon's message wording is not a
	// contract and would break this silently if it were ever reworded.
	it("ignores a matching message when the code is absent", () => {
		expect(shouldRetryOnTerminal({ status: 409, code: undefined })).toBe(false);
	});
});

describe("routeForSend", () => {
	it("sends to the agent by default", () => {
		expect(routeForSend("agent")).toBe("agent");
	});

	it("honours the explicit terminal target", () => {
		expect(routeForSend("terminal")).toBe("terminal");
		expect(routeForSend("terminal", { status: 500, code: "INTERNAL" })).toBe("terminal");
	});

	it("auto-engages the terminal route for a blocked prompt", () => {
		expect(routeForSend("agent", { status: 409, code: AWAITING_DECISION })).toBe("terminal");
	});

	it("keeps ordinary failures on the agent route", () => {
		expect(routeForSend("agent", { status: 401 })).toBe("agent");
		expect(routeForSend("agent", { status: 409, code: "SESSION_TERMINATED" })).toBe("agent");
	});
});

describe("terminalPayload", () => {
	it("submits the line with a carriage return", () => {
		expect(terminalPayload("y")).toBe("y\r");
	});

	it("leaves single-line text otherwise untouched", () => {
		expect(terminalPayload("git commit -m 'x'")).toBe("git commit -m 'x'\r");
	});

	// The composer is multiline, so pasted or dictated text can carry newlines.
	// A PTY reads each one as Enter, which would answer a dialog with the first
	// fragment and feed the rest to whatever opened next.
	it("collapses interior newlines so one message submits once", () => {
		expect(terminalPayload("yes,\nuse the second option")).toBe("yes, use the second option\r");
		expect(terminalPayload("a\r\nb")).toBe("a b\r");
		expect(terminalPayload("a\n\n\nb")).toBe("a b\r");
	});

	it("drops surrounding whitespace so there is no empty second submission", () => {
		expect(terminalPayload("approve\n")).toBe("approve\r");
		expect(terminalPayload("\n approve \n")).toBe("approve\r");
	});

	it("still submits when the text is only newlines", () => {
		expect(terminalPayload("\n\n")).toBe("\r");
	});
});
