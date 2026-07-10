import { afterEach, describe, expect, it } from "vitest";
import { apiClient, setApiBaseUrl } from "./api-client";
import { applyDaemonStatus } from "./daemon-status";

describe("applyDaemonStatus failure messages", () => {
	afterEach(() => {
		// Restore the trusted-base default other suites expect.
		applyDaemonStatus({ state: "ready", port: 3001 });
	});

	it("surfaces the specific daemon failure reason through the api-client 503 body", async () => {
		// Regression for #2481: the identity-mismatch diagnostic was computed in
		// the main process, sent over IPC, and then dropped — every API call
		// surfaced only the generic "AO daemon is not ready." fallback.
		const identityMessage =
			"Another AO daemon is already running from /other/checkout; expected this checkout at /this/checkout. Stop the other daemon before using this checkout.";
		applyDaemonStatus({ state: "error", code: "identity_mismatch", message: identityMessage });

		const { error } = await apiClient.GET("/api/v1/projects");

		expect(error).toEqual({ message: identityMessage });
	});

	it("falls back to the generic message when the status carries no reason", async () => {
		applyDaemonStatus({ state: "starting" });

		const { error } = await apiClient.GET("/api/v1/projects");

		expect(error).toEqual({ message: "AO daemon is not ready." });
	});

	it("clears a stale failure reason once the daemon is ready again", async () => {
		applyDaemonStatus({ state: "error", code: "spawn_failed", message: "spawn ENOENT" });
		applyDaemonStatus({ state: "ready", port: 3001 });

		// The daemon later vanishes without a diagnostic (e.g. status listener
		// pushes a bare stop); the old reason must not resurface.
		setApiBaseUrl(null);

		const { error } = await apiClient.GET("/api/v1/projects");

		expect(error).toEqual({ message: "AO daemon is not ready." });
	});
});
