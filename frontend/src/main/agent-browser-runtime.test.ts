import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AgentBrowserRuntime,
	nativeArgumentsForAction,
	validateAgentBrowserArguments,
} from "./agent-browser-runtime";

describe("agent-browser command policy", () => {
	it("allows the focused semantic workflow", () => {
		expect(() => validateAgentBrowserArguments(["snapshot", "-i", "--json"])).not.toThrow();
		expect(() => validateAgentBrowserArguments(["find", "role", "button", "click", "--name", "Save"])).not.toThrow();
		expect(() => validateAgentBrowserArguments(["wait", "--text", "Saved"])).not.toThrow();
		expect(() => validateAgentBrowserArguments(["open", "http://localhost:5173"])).not.toThrow();
	});

	it("blocks browser ownership, persistence, arbitrary evaluation, and unsafe navigation", () => {
		for (const args of [
			["connect", "9222"],
			["eval", "document.cookie"],
			["snapshot", "--cdp", "9222"],
			["snapshot", "--profile", "Default"],
			["get", "cdp-url"],
			["open", "file:///tmp/secret"],
			["network", "route", "*", "--abort"],
		]) {
			expect(() => validateAgentBrowserArguments(args)).toThrow();
		}
	});
});

describe("AO action translation", () => {
	it("maps the public snapshot and ref contract to native arguments", () => {
		expect(nativeArgumentsForAction("snapshot", { interactive: true })).toEqual([
			"snapshot",
			"--interactive",
			"--compact",
		]);
		expect(nativeArgumentsForAction("click", { ref: "e2" })).toEqual(["click", "@e2"]);
		expect(nativeArgumentsForAction("drag", { ref: "e2", targetRef: "@e5" })).toEqual([
			"drag",
			"@e2",
			"@e5",
		]);
	});

	it("maps waits, tabs, frames, and dialogs without accepting arbitrary evaluation", () => {
		expect(nativeArgumentsForAction("wait", { textGone: "Saving...", timeoutMs: 2_500 })).toEqual([
			"wait",
			"text=Saving...",
			"--state",
			"hidden",
			"--timeout",
			"2500",
		]);
		expect(nativeArgumentsForAction("tab-select", { tabId: "t2" })).toEqual(["tab", "t2"]);
		expect(nativeArgumentsForAction("get", { property: "text" })).toEqual(["get", "text"]);
		const stableWait = nativeArgumentsForAction("wait", { stableMs: 750, timeoutMs: 2_500 });
		expect(stableWait.slice(0, 2)).toEqual(["wait", "--fn"]);
		expect(stableWait[2]).toContain("750");
		expect(stableWait.slice(-2)).toEqual(["--timeout", "2500"]);
		expect(nativeArgumentsForAction("frame", { target: "e7" })).toEqual(["frame", "@e7"]);
		expect(nativeArgumentsForAction("dialog", { operation: "accept", text: "yes" })).toEqual([
			"dialog",
			"accept",
			"yes",
		]);
		expect(() => nativeArgumentsForAction("eval", { expression: "document.cookie" })).toThrow();
	});
});

const nativeBinary = process.env.AO_AGENT_BROWSER_TEST_BINARY;
describe.skipIf(!nativeBinary)("agent-browser native compatibility", () => {
	it("connects the pinned native daemon through AO's scoped CDP bridge", async () => {
		class DebuggerFixture extends EventEmitter {
			attached = false;
			attach() {
				this.attached = true;
			}
			detach() {
				this.attached = false;
				this.emit("detach");
			}
			isAttached() {
				return this.attached;
			}
			async sendCommand(method: string) {
				if (method === "Runtime.evaluate") {
					return { result: { type: "string", value: "http://localhost:5173/" } };
				}
				if (method === "Page.captureScreenshot") {
					return {
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
					};
				}
				return {};
			}
		}
		const debug = new DebuggerFixture();
		const provider = {
			listTargets: () => [
				{
					id: "t1",
					url: "http://localhost:5173/",
					title: "Fixture",
					debugger: debug,
				},
			],
			createTarget: async () => {
				throw new Error("unexpected target creation");
			},
			activateTarget: () => undefined,
			closeTarget: () => undefined,
		};
		const runtime = new AgentBrowserRuntime({
			binaryPath: nativeBinary!,
			dataDir: path.join(os.tmpdir(), "ao-agent-browser-native-test"),
		});
		try {
			const result = await runtime.runAction("native-fixture", "get", { property: "url" }, provider);
			expect(result.url).toBe("http://localhost:5173/");
			const screenshot = await runtime.screenshot("native-fixture", provider);
			expect(screenshot).toMatchObject({ width: 1, height: 1 });
		} finally {
			await runtime.dispose();
		}
	});
});
