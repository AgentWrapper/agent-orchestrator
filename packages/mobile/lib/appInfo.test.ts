import { describe, expect, it } from "vitest";
import { bugReportBody, formatVersion } from "./appInfo";

describe("formatVersion", () => {
	it("combines version and build", () => {
		expect(formatVersion({ version: "1.2.0", build: "42" })).toBe("1.2.0 (42)");
	});

	it("omits a build number that only repeats the version", () => {
		// Expo Go reports both as the same string; "1.2.0 (1.2.0)" is noise.
		expect(formatVersion({ version: "1.2.0", build: "1.2.0" })).toBe("1.2.0");
	});

	it("omits a missing or blank build number", () => {
		expect(formatVersion({ version: "1.2.0" })).toBe("1.2.0");
		expect(formatVersion({ version: "1.2.0", build: "  " })).toBe("1.2.0");
	});

	it("falls back rather than rendering an empty row", () => {
		expect(formatVersion({})).toBe("unknown");
		expect(formatVersion({ build: "42" })).toBe("build 42");
	});
});

describe("bugReportBody", () => {
	it("names the build and platform so a report is actionable", () => {
		const body = bugReportBody({ version: "1.2.0", build: "42" }, "ios", "18.2");
		expect(body).toContain("AO mobile: 1.2.0 (42)");
		expect(body).toContain("Platform: ios 18.2");
	});

	it("leaves room above the metadata for the user to type", () => {
		expect(bugReportBody({ version: "1.0.0" }, "android", 34).startsWith("\n\n")).toBe(true);
	});
});
