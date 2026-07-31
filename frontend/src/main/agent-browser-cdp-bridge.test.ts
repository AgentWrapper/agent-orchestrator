import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
	AgentBrowserCDPBridge,
	type AgentBrowserDebugger,
	type AgentBrowserTarget,
} from "./agent-browser-cdp-bridge";

class FakeDebugger extends EventEmitter implements AgentBrowserDebugger {
	attached = false;
	readonly sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => ({
		method,
		params,
	}));

	attach(): void {
		this.attached = true;
	}

	detach(): void {
		this.attached = false;
		this.emit("detach");
	}

	isAttached(): boolean {
		return this.attached;
	}
}

describe("worker-scoped agent-browser CDP bridge", () => {
	it("exposes only provider targets and forwards flattened target commands", async () => {
		const debug = new FakeDebugger();
		const targets: AgentBrowserTarget[] = [
			{ id: "t1", url: "http://localhost:5173/", title: "AO fixture", debugger: debug },
		];
		const provider = {
			listTargets: () => targets,
			createTarget: vi.fn(async () => targets[0]),
			activateTarget: vi.fn(),
			closeTarget: vi.fn(),
		};
		const bridge = new AgentBrowserCDPBridge(provider);
		const endpoint = await bridge.start();
		const socket = await connect(endpoint);

		try {
			const listed = await rpc(socket, 1, "Target.getTargets");
			expect(listed.result).toEqual({
				targetInfos: [
					expect.objectContaining({
						targetId: "t1",
						type: "page",
						url: "http://localhost:5173/",
					}),
				],
			});

			const attached = await rpc(socket, 2, "Target.attachToTarget", { targetId: "t1", flatten: true });
			const sessionId = (attached.result as { sessionId: string }).sessionId;
			expect(sessionId).toMatch(/^ao-/);

			const forwarded = await rpc(socket, 3, "Runtime.evaluate", { expression: "document.title" }, sessionId);
			expect(forwarded.result).toEqual({
				method: "Runtime.evaluate",
				params: { expression: "document.title" },
			});
			expect(debug.sendCommand).toHaveBeenCalledWith("Runtime.evaluate", {
				expression: "document.title",
			});

			const sibling = await rpc(socket, 4, "Target.attachToTarget", { targetId: "other-worker" });
			expect(sibling.error?.message).toContain("outside this AO worker");

			const close = await rpc(socket, 5, "Browser.close");
			expect(close.error?.message).toContain("not permitted");
		} finally {
			socket.close();
			await bridge.close();
		}
	});
});

type RPCResponse = {
	id: number;
	result?: unknown;
	error?: { message: string };
};

async function connect(endpoint: string): Promise<WebSocket> {
	const socket = new WebSocket(endpoint);
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	return socket;
}

async function rpc(
	socket: WebSocket,
	id: number,
	method: string,
	params?: Record<string, unknown>,
	sessionId?: string,
): Promise<RPCResponse> {
	const response = new Promise<RPCResponse>((resolve) => {
		const listener = (data: Buffer) => {
			const message = JSON.parse(data.toString()) as RPCResponse;
			if (message.id !== id) return;
			socket.off("message", listener);
			resolve(message);
		};
		socket.on("message", listener);
	});
	socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
	return response;
}
