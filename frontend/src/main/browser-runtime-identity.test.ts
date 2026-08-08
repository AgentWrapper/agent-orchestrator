import { describe, expect, it } from "vitest";
import { sameBrowserRuntimeIdentity, type BrowserRuntimeIdentity } from "./browser-runtime-identity";

const identity: BrowserRuntimeIdentity = {
	pid: 42,
	startedAtMs: 1_725_000_000_000,
	address: "\\\\.\\pipe\\ao-browser-dev",
	token: "token-1",
};

describe("browser runtime identity", () => {
	it("keeps the existing link for the same daemon generation", () => {
		expect(sameBrowserRuntimeIdentity(identity, { ...identity })).toBe(true);
	});

	it.each([
		["pid", { pid: 43 }],
		["start time", { startedAtMs: identity.startedAtMs + 1 }],
		["address", { address: "\\\\.\\pipe\\ao-browser-next" }],
		["token", { token: "token-2" }],
	])("rebuilds the link when the daemon %s changes", (_label, change) => {
		expect(sameBrowserRuntimeIdentity(identity, { ...identity, ...change })).toBe(false);
	});
});
