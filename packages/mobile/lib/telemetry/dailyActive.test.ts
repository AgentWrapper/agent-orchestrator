import { describe, expect, it } from "vitest";
import { ACTIVE_STORAGE_KEY, reserveDailyActive } from "./dailyActive";

function memory(initial?: Record<string, string>) {
	const map = new Map<string, string>(Object.entries(initial ?? {}));
	return {
		map,
		getItem: async (k: string) => map.get(k) ?? null,
		setItem: async (k: string, v: string) => void map.set(k, v),
	};
}

describe("reserveDailyActive", () => {
	it("returns true once per UTC day and false for the rest of that day", async () => {
		const s = memory();
		expect(await reserveDailyActive(s, new Date("2026-08-06T00:05:00Z"))).toBe(true);
		expect(await reserveDailyActive(s, new Date("2026-08-06T09:00:00Z"))).toBe(false);
		expect(await reserveDailyActive(s, new Date("2026-08-06T23:59:59Z"))).toBe(false);
		expect(await reserveDailyActive(s, new Date("2026-08-07T00:00:00Z"))).toBe(true);
	});

	it("persists the reserved day", async () => {
		const s = memory();
		await reserveDailyActive(s, new Date("2026-08-06T10:00:00Z"));
		expect(s.map.get(ACTIVE_STORAGE_KEY)).toBe("2026-08-06");
	});

	it("reads a day already reported by a previous launch as spent", async () => {
		const s = memory({ [ACTIVE_STORAGE_KEY]: "2026-08-06" });
		expect(await reserveDailyActive(s, new Date("2026-08-06T14:00:00Z"))).toBe(false);
	});

	it("allows the emit when storage is unavailable, at most once per start", async () => {
		expect(await reserveDailyActive(undefined, new Date("2026-08-06T10:00:00Z"))).toBe(true);
	});

	it("allows the emit when storage throws rather than losing the user", async () => {
		const throwing = {
			getItem: async () => { throw new Error("keystore locked"); },
			setItem: async () => { throw new Error("keystore locked"); },
		};
		expect(await reserveDailyActive(throwing, new Date("2026-08-06T10:00:00Z"))).toBe(true);
	});
});
