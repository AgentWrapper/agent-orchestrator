/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureRendererEvent, writeText, openExternal } = vi.hoisted(() => ({
	captureRendererEvent: vi.fn(),
	writeText: vi.fn(),
	openExternal: vi.fn(),
}));

// Spread the real module so routeSurface and anything else the diagnostics
// collector imports stays intact; only the capture call is replaced.
vi.mock("../../lib/telemetry", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/telemetry")>()),
	captureRendererEvent,
}));
vi.mock("../../lib/bridge", () => ({
	aoBridge: {
		clipboard: { writeText },
		// getVersion and getStatus back the diagnostics block the dialog collects
		// on open; without them the open effect rejects.
		app: { openExternal, getVersion: async () => "0.11.2" },
		daemon: { getStatus: async () => ({ state: "running" }) },
	},
}));

import { ReportProblemDialog } from "./ReportProblemDialog";

const SUMMARY = "crashes on open";
const DETAILS = "stack trace from /Users/me/work/secret-client";

function events(name: string) {
	return captureRendererEvent.mock.calls.filter((c) => c[0] === name);
}

async function renderOpen(open = true) {
	const result = render(<ReportProblemDialog open={open} onOpenChange={vi.fn()} />);
	await act(async () => {
		await Promise.resolve();
	});
	return result;
}

// The submit button's label follows the chosen destination ("Copy & Create
// GitHub Issue" / "Copy & Open Discord"), so it is matched on the shared prefix
// rather than one destination's wording.
async function fillAndSubmit() {
	fireEvent.change(screen.getByPlaceholderText(/brief title/i), { target: { value: SUMMARY } });
	fireEvent.change(screen.getByPlaceholderText(/share what happened/i), { target: { value: DETAILS } });
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: /^copy & /i }));
		await Promise.resolve();
	});
}

describe("Report a problem telemetry", () => {
	beforeEach(() => {
		captureRendererEvent.mockClear();
		writeText.mockReset().mockResolvedValue(undefined);
		openExternal.mockReset().mockResolvedValue(undefined);
	});

	it("reports the open once, with no properties", async () => {
		await renderOpen();
		expect(events("ao.renderer.support_opened")).toHaveLength(1);
		expect(events("ao.renderer.support_opened")[0][1]).toBeUndefined();
	});

	it("reports nothing while closed", async () => {
		await renderOpen(false);
		expect(captureRendererEvent).not.toHaveBeenCalled();
	});

	it("reports the destination on a successful hand-off, never the report text", async () => {
		await renderOpen();
		await fillAndSubmit();

		await waitFor(() => expect(events("ao.renderer.support_submitted")).toHaveLength(1));
		expect(events("ao.renderer.support_submitted")[0][1]).toEqual({
			destination: "github",
			outcome: "succeeded",
		});

		// The summary, details, and the local path inside them are on screen and in
		// the clipboard draft, so assert directly that none of it is ever reported.
		const reported = JSON.stringify(captureRendererEvent.mock.calls);
		expect(reported).not.toContain(SUMMARY);
		expect(reported).not.toContain(DETAILS);
		expect(reported).not.toContain("secret-client");
	});

	// A failing hand-off is the case worth seeing: the user wrote a report and it
	// went nowhere. Reporting only successes would hide exactly that.
	it("reports a failed hand-off rather than staying silent", async () => {
		writeText.mockRejectedValue(new Error("clipboard blocked"));
		await renderOpen();
		await fillAndSubmit();

		await waitFor(() => expect(events("ao.renderer.support_submitted")).toHaveLength(1));
		expect(events("ao.renderer.support_submitted")[0][1]).toEqual({
			destination: "github",
			outcome: "failed",
		});
		// The thrown message can carry paths and URLs, so it must not be reported.
		expect(JSON.stringify(captureRendererEvent.mock.calls)).not.toContain("clipboard blocked");
	});

	it("reports the destination the user actually chose", async () => {
		await renderOpen();
		fireEvent.click(screen.getByRole("radio", { name: /discord/i }));
		await fillAndSubmit();

		await waitFor(() => expect(events("ao.renderer.support_submitted")).toHaveLength(1));
		expect(events("ao.renderer.support_submitted")[0][1]).toMatchObject({ destination: "discord" });
	});
});
