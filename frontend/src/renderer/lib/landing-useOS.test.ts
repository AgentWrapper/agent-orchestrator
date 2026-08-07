import { describe, expect, test } from "vitest";
import {
	detectPlatformInfo,
	Platform,
} from "../../landing/src/app/hooks/useOS/useOS";

describe("detectPlatformInfo", () => {
	test.each([
		{
			name: "modern iPad",
			userAgent:
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1",
			maxTouchPoints: 5,
			mobileOS: "ios",
		},
		{
			name: "legacy iPad",
			userAgent:
				"Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
			maxTouchPoints: 5,
			mobileOS: "ios",
		},
		{
			name: "iPhone",
			userAgent:
				"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
			maxTouchPoints: 5,
			mobileOS: "ios",
		},
		{
			name: "Android",
			userAgent:
				"Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36",
			maxTouchPoints: 5,
			mobileOS: "android",
		},
	] as const)("classifies $name as mobile", ({ userAgent, maxTouchPoints, mobileOS }) => {
		expect(detectPlatformInfo(userAgent, maxTouchPoints)).toEqual({
			platform: Platform.Mobile,
			mobileOS,
		});
	});

	test("does not classify a real Mac as mobile", () => {
		const result = detectPlatformInfo(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15",
			0,
		);

		expect(result.platform).not.toBe(Platform.Mobile);
		expect(result.mobileOS).toBeNull();
	});
});
