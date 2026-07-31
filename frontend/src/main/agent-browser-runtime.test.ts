import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { AgentBrowserRuntime, validateAgentBrowserArguments } from "./agent-browser-runtime";

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
			enabled: true,
			binaryPath: nativeBinary!,
		});
		try {
			const result = await runtime.run("native-fixture", ["get", "url"], provider);
			expect(result.stdout).toContain("http://localhost:5173/");
		} finally {
			await runtime.dispose();
		}
	});
});
