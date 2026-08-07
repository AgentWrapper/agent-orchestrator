import { describe, expect, it, vi } from "vitest";
import { ACTIVE_STORAGE_KEY } from "./dailyActive";
import { MOBILE_EVENTS } from "./events";
import { createMobileTelemetry, type MobileTelemetryClient } from "./telemetry";

function fakeClient() {
	const captures: Array<{ event: string; props?: Record<string, unknown> }> = [];
	const registered: Record<string, unknown>[] = [];
	const client: MobileTelemetryClient = {
		capture: (event, props) => captures.push({ event, props }),
		register: (props) => void registered.push(props),
	};
	return { client, captures, registered };
}

function memory(initial?: Record<string, string>) {
	const map = new Map(Object.entries(initial ?? {}));
	return {
		getItem: async (k: string) => map.get(k) ?? null,
		setItem: async (k: string, v: string) => void map.set(k, v),
	};
}

describe("createMobileTelemetry", () => {
	it("registers the context as super-properties once on creation", () => {
		const { client, registered } = fakeClient();
		createMobileTelemetry(client, { client: "mobile", platform: "ios" });
		expect(registered).toEqual([{ client: "mobile", platform: "ios" }]);
	});

	it("sanitizes properties on capture, dropping anything unregistered", () => {
		const { client, captures } = fakeClient();
		const t = createMobileTelemetry(client, {});
		t.capture(MOBILE_EVENTS.featureUsed, {
			feature: "spawn",
			outcome: "succeeded",
			session_title: "leak me",
			password: "hunter2",
		});
		expect(captures).toEqual([
			{
				event: MOBILE_EVENTS.featureUsed,
				props: { feature: "spawn", outcome: "succeeded", $process_person_profile: false },
			},
		]);
	});

	// Fail closed on the event name: a typo must send nothing, not a bare event.
	it("drops an event name that is not in the allowlist", () => {
		const { client, captures } = fakeClient();
		const t = createMobileTelemetry(client, {});
		// @ts-expect-error deliberately passing an unknown event name
		t.capture("ao.mobile_app.typo", { feature: "spawn" });
		expect(captures).toEqual([]);
	});

	it("stamps $process_person_profile:false on every event for the anonymous rate", () => {
		const { client, captures } = fakeClient();
		const t = createMobileTelemetry(client, {});
		t.capture(MOBILE_EVENTS.paired, { method: "qr" });
		expect(captures[0].props?.$process_person_profile).toBe(false);
	});

	it("drops an event named in the build-time kill switch", () => {
		const { client, captures } = fakeClient();
		const t = createMobileTelemetry(client, {}, { disabledEvents: [MOBILE_EVENTS.connected] });
		t.capture(MOBILE_EVENTS.connected, { trigger: "launch" });
		t.capture(MOBILE_EVENTS.paired, { method: "qr" });
		expect(captures.map((c) => c.event)).toEqual([MOBILE_EVENTS.paired]);
	});

	it("drops an event the rate limiter rejects", () => {
		const { client, captures } = fakeClient();
		let calls = 0;
		const t = createMobileTelemetry(client, {}, { allow: () => (++calls <= 1) });
		t.capture(MOBILE_EVENTS.paired, { method: "qr" }); // 1st: allowed
		t.capture(MOBILE_EVENTS.paired, { method: "qr" }); // 2nd: rate-limited
		expect(captures).toHaveLength(1);
	});

	it("emits the daily active heartbeat once per UTC day", async () => {
		const { client, captures } = fakeClient();
		const store = memory();
		const t = createMobileTelemetry(client, {});
		await t.active(store, new Date("2026-08-06T01:00:00Z"));
		await t.active(store, new Date("2026-08-06T20:00:00Z"));
		await t.active(store, new Date("2026-08-07T00:01:00Z"));
		expect(captures.map((c) => c.event)).toEqual([MOBILE_EVENTS.active, MOBILE_EVENTS.active]);
	});

	it("marks the active day in storage", async () => {
		const { client } = fakeClient();
		const store = memory();
		const t = createMobileTelemetry(client, {});
		await t.active(store, new Date("2026-08-06T01:00:00Z"));
		expect(await store.getItem(ACTIVE_STORAGE_KEY)).toBe("2026-08-06");
	});
});
