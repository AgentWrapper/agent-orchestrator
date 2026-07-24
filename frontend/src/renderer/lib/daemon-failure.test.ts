import { describe, expect, it } from "vitest";
import { daemonFailureTitle } from "./daemon-failure";

describe("daemonFailureTitle", () => {
	it.each([
		{ code: "not_ready" as const, title: "AO daemon is not ready yet" },
		{ code: "port_unconfirmed" as const, title: "AO daemon is not ready yet" },
		{ code: "not_configured" as const, title: "AO daemon is not configured" },
		{ code: "daemon_unreachable" as const, title: "AO daemon is unreachable" },
		{ code: "identity_mismatch" as const, title: "AO daemon identity check failed" },
		{ code: "binary_missing" as const, title: "AO daemon binary is missing" },
		{ code: "spawn_failed" as const, title: "AO daemon failed to start" },
		{ code: "exited" as const, title: "AO daemon failed to start" },
	])("returns $title for $code", ({ code, title }) => {
		expect(daemonFailureTitle({ state: "error", code })).toBe(title);
	});
});
