import { describe, expect, it } from "vitest";
import { formatDateTime, formatTimeCompact } from "./format-time";

const NOW = Date.parse("2026-07-17T12:00:00Z");

describe("formatTimeCompact", () => {
	it.each([undefined, null, "", "not-a-date", "2026-07-17T12:00:01Z", "2026-07-17T11:59:30Z"])(
		"renders missing, invalid, future, and sub-minute values as just now (%s)",
		(value) => {
			expect(formatTimeCompact(value, "en", NOW)).toBe("just now");
			expect(formatTimeCompact(value, "zh-CN", NOW)).toBe("刚刚");
		},
	);

	it("preserves floor-based minute, hour, and day thresholds", () => {
		expect(formatTimeCompact("2026-07-17T11:00:01Z", "en", NOW)).toBe("59m ago");
		expect(formatTimeCompact("2026-07-17T11:00:00Z", "en", NOW)).toBe("1h ago");
		expect(formatTimeCompact("2026-07-16T12:00:01Z", "en", NOW)).toBe("23h ago");
		expect(formatTimeCompact("2026-07-16T12:00:00Z", "en", NOW)).toBe("1d ago");
	});

	it("formats compact relative time in English and Chinese", () => {
		expect(formatTimeCompact("2026-07-17T10:00:00Z", "en", NOW)).toBe("2h ago");
		expect(formatTimeCompact("2026-07-17T10:00:00Z", "zh-CN", NOW)).toBe("2小时前");
	});
});

describe("formatDateTime", () => {
	it("formats an absolute date and time using the selected locale", () => {
		const options = { timeZone: "UTC" } as const;
		expect(formatDateTime("2026-07-17T10:15:00Z", "en", options)).toContain("Jul 17, 2026");
		expect(formatDateTime("2026-07-17T10:15:00Z", "zh-CN", options)).toContain("2026年7月17日");
	});
});
