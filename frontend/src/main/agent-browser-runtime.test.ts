import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	AgentBrowserRuntime,
	BROWSER_RUNTIME_RECLAIM_GRACE_MS,
	nativeArgumentsForAction,
	scavengeBrowserRuntime,
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

describe("agent-browser runtime lifecycle", () => {
	const provider = {
		listTargets: () => [],
		createTarget: async () => {
			throw new Error("unexpected target creation");
		},
		activateTarget: () => undefined,
		closeTarget: () => undefined,
	};

	async function fixture(overrides: {
		start?: () => Promise<string>;
		close?: () => Promise<void>;
		processRunner?: (...args: unknown[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
	} = {}) {
		const dataDir = await mkdtemp(path.join(os.tmpdir(), "ao-browser-runtime-test-"));
		const bridge = {
			start: vi.fn(overrides.start ?? (async () => "ws://127.0.0.1:1/fixture")),
			close: vi.fn(overrides.close ?? (async () => undefined)),
			endpointForTarget: vi.fn(() => "ws://127.0.0.1:1/fixture?target=t1"),
		};
		const processRunner = vi.fn(
			overrides.processRunner ?? (async () => ({ stdout: "", stderr: "", exitCode: 0 })),
		);
		const runtime = new AgentBrowserRuntime({
			binaryPath: process.execPath,
			dataDir,
			bridgeFactory: () => bridge,
			processRunner: processRunner as never,
			processAlive: () => false,
		});
		return { dataDir, bridge, processRunner, runtime };
	}

	async function cleanup(dataDir: string): Promise<void> {
		await rm(dataDir, { recursive: true, force: true });
	}

	it("serializes concurrent initialization and removes the owned run root", async () => {
		const { dataDir, bridge, runtime } = await fixture();
		try {
			const endpoints = await Promise.all([
				runtime.devtoolsEndpoint("session-1", "t1", provider),
				runtime.devtoolsEndpoint("session-1", "t1", provider),
			]);
			expect(endpoints).toEqual([endpoints[0], endpoints[0]]);
			expect(bridge.start).toHaveBeenCalledTimes(1);

			await runtime.dispose();
			expect(await readdir(dataDir)).toEqual([]);
		} finally {
			await cleanup(dataDir);
		}
	});

	it("makes dispose await a close already started by session destruction", async () => {
		let releaseClose!: () => void;
		const closeFinished = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		const { dataDir, processRunner, runtime } = await fixture({
			processRunner: async (...args) => {
				if (Array.isArray(args[1]) && args[1][0] === "close") await closeFinished;
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		});
		try {
			await runtime.devtoolsEndpoint("session-1", "t1", provider);
			const closing = runtime.closeSession("session-1");
			await vi.waitFor(() => expect(processRunner).toHaveBeenCalledWith(
				process.execPath,
				["close"],
				expect.any(Object),
				undefined,
				10_000,
			));
			const disposing = runtime.dispose();
			let disposed = false;
			void disposing.then(() => {
				disposed = true;
			});
			await Promise.resolve();
			expect(disposed).toBe(false);
			releaseClose();
			await Promise.all([closing, disposing]);
			expect(await readdir(dataDir)).toEqual([]);
		} finally {
			releaseClose();
			await cleanup(dataDir);
		}
	});

	it("removes the session directory even when bridge close fails", async () => {
		const { dataDir, bridge, runtime } = await fixture({
			close: async () => {
				throw new Error("bridge already closed");
			},
		});
		try {
			await runtime.devtoolsEndpoint("session-1", "t1", provider);
			await runtime.dispose();
			expect(bridge.close).toHaveBeenCalledTimes(1);
			expect(await readdir(dataDir)).toEqual([]);
		} finally {
			await cleanup(dataDir);
		}
	});

	it("recovers only confirmed-dead marked run roots", async () => {
		const dataDir = await mkdtemp(path.join(os.tmpdir(), "ao-browser-scavenge-test-"));
		try {
			const dead = path.join(dataDir, "run-101-aaaaaaaaaaaa");
			const alive = path.join(dataDir, "run-202-bbbbbbbbbbbb");
			const malformed = path.join(dataDir, "run-303-cccccccccccc");
			const empty = path.join(dataDir, "run-404-dddddddddddd");
			const legacy = path.join(dataDir, "ao-legacy-session");
			await Promise.all([mkdir(dead), mkdir(alive), mkdir(malformed), mkdir(empty), mkdir(legacy)]);
			const deadOwnerPath = path.join(dead, "owner.json");
			await writeFile(
				deadOwnerPath,
				JSON.stringify({ marker: "AO_BROWSER_RUNTIME_V1", pid: 101, startedAt: new Date().toISOString(), token: "a".repeat(32) }),
			);
			const staleAt = new Date(Date.now() - BROWSER_RUNTIME_RECLAIM_GRACE_MS - 1_000);
			await utimes(deadOwnerPath, staleAt, staleAt);
			await writeFile(
				path.join(alive, "owner.json"),
				JSON.stringify({ marker: "AO_BROWSER_RUNTIME_V1", pid: 202, startedAt: new Date().toISOString(), token: "b".repeat(32) }),
			);
			await writeFile(path.join(malformed, "owner.json"), "not-json");
			await writeFile(path.join(legacy, "config.json"), "{}\n");

			await scavengeBrowserRuntime(dataDir, (pid) => pid === 202);

			expect((await readdir(dataDir)).sort()).toEqual([
				"ao-legacy-session",
				"run-202-bbbbbbbbbbbb",
				"run-303-cccccccccccc",
				"run-404-dddddddddddd",
			]);
			expect(await readFile(path.join(legacy, "config.json"), "utf8")).toBe("{}\n");
		} finally {
			await cleanup(dataDir);
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
