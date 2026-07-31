import { describe, expect, it } from "vitest";
import type { UpdateStatus } from "../../main/update-settings";
import { updateFailureCategory, updateTelemetryFor } from "./update-telemetry";

const at = (state: UpdateStatus["state"], extra: Partial<UpdateStatus> = {}): UpdateStatus => ({
	state,
	...extra,
});

describe("update telemetry", () => {
	it("buckets updater error messages into safe categories", () => {
		expect(updateFailureCategory("net::ERR_CONNECTION_RESET")).toBe("network");
		expect(updateFailureCategory("getaddrinfo ENOTFOUND github.com")).toBe("network");
		expect(updateFailureCategory("sha512 checksum mismatch")).toBe("signature");
		expect(updateFailureCategory("code signature validation failed")).toBe("signature");
		expect(updateFailureCategory("EACCES: permission denied")).toBe("permission");
		expect(updateFailureCategory("ENOSPC: no space left on device")).toBe("disk_space");
		expect(updateFailureCategory("Cannot update: unsupported platform")).toBe("not_supported");
		expect(updateFailureCategory(undefined)).toBe("unknown");
		expect(updateFailureCategory("")).toBe("unknown");
	});

	// The raw message can carry the feed URL and local staging paths, so it must
	// never reach the wire. Only the bucketed category does.
	it("never puts the raw updater message on the event", () => {
		const planned = updateTelemetryFor(
			at("downloading"),
			at("error", { message: "EACCES /Users/someone/Library/Caches/ao-updater/pending" }),
		);
		expect(planned?.event).toBe("ao.renderer.update_failed");
		expect(JSON.stringify(planned?.properties)).not.toContain("someone");
		expect(planned?.properties.error_category).toBe("permission");
	});

	it("labels which phase failed using the previous state", () => {
		expect(updateTelemetryFor(at("downloading"), at("error"))?.properties.phase).toBe("download");
		expect(updateTelemetryFor(at("checking"), at("error"))?.properties.phase).toBe("check");
		// No prior state at all (first push after launch) is treated as a check.
		expect(updateTelemetryFor(null, at("error"))?.properties.phase).toBe("check");
	});

	it("reports a staged update with the version it will install", () => {
		const planned = updateTelemetryFor(at("downloading"), at("downloaded", { version: "0.11.2" }));
		expect(planned?.event).toBe("ao.renderer.update_downloaded");
		expect(planned?.properties.to_version).toBe("0.11.2");
	});

	// The status channel re-pushes on reconnect and on every percent tick. Without
	// transition detection, a downloaded update would re-report for as long as the
	// app stays open, which is exactly the kind of repeat that caused the original
	// volume problem.
	it("only reports on a real transition", () => {
		const downloaded = at("downloaded", { version: "0.11.2" });
		expect(updateTelemetryFor(null, downloaded)).not.toBeNull();
		expect(updateTelemetryFor(downloaded, downloaded)).toBeNull();
		expect(updateTelemetryFor(downloaded, at("downloaded", { version: "0.11.2", percent: 100 }))).toBeNull();
		// A different version staged after the first is genuinely new.
		expect(updateTelemetryFor(downloaded, at("downloaded", { version: "0.11.3" }))).not.toBeNull();
	});

	it("stays silent for progress and healthy states", () => {
		for (const state of ["idle", "checking", "available", "not-available", "downloading"] as const) {
			expect(updateTelemetryFor(at("idle"), at(state))).toBeNull();
		}
	});

	it("reports an unsupported install, which can never self-update", () => {
		const planned = updateTelemetryFor(at("checking"), at("unsupported"));
		expect(planned?.event).toBe("ao.renderer.update_unsupported");
		expect(planned?.properties.error_category).toBe("not_supported");
	});
});
