import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectBrowserRuntime, type BrowserRuntimeLinkHandle } from "./browser-runtime-link";

const handles: BrowserRuntimeLinkHandle[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
	handles.splice(0).forEach((handle) => handle.dispose());
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		),
	);
});

describe("browser runtime link", () => {
	it("handshakes and correlates a command result", async () => {
		const execute = vi.fn(async () => ({ text: "button Save [ref=e1]" }));
		let serverSocket: net.Socket | null = null;
		let inbound = "";
		const messages: unknown[] = [];
		const server = net.createServer((socket) => {
			serverSocket = socket;
			socket.on("data", (chunk) => {
				inbound += chunk.toString("utf8");
				for (;;) {
					const newline = inbound.indexOf("\n");
					if (newline < 0) return;
					messages.push(JSON.parse(inbound.slice(0, newline)));
					inbound = inbound.slice(newline + 1);
				}
			});
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as net.AddressInfo;
		const handle = connectBrowserRuntime({ host: address.address, port: address.port }, { execute });
		handles.push(handle);
		await vi.waitFor(() => expect(handle.connected).toBe(true));
		await vi.waitFor(() => expect(messages).toContainEqual({ type: "hello", version: 1 }));

		serverSocket!.write(
			`${JSON.stringify({ type: "command", requestId: "r1", sessionId: "s1", action: "snapshot", args: {} })}\n`,
		);

		await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(expect.objectContaining({ requestId: "r1" })));
		await vi.waitFor(() =>
			expect(messages).toContainEqual({
				type: "result",
				requestId: "r1",
				ok: true,
				result: { text: "button Save [ref=e1]" },
			}),
		);
	});

	it("returns structured command errors", async () => {
		let serverSocket: net.Socket | null = null;
		let inbound = "";
		const messages: unknown[] = [];
		const server = net.createServer((socket) => {
			serverSocket = socket;
			socket.on("data", (chunk) => {
				inbound += chunk.toString("utf8");
				const lines = inbound.split("\n");
				inbound = lines.pop() ?? "";
				for (const line of lines) if (line) messages.push(JSON.parse(line));
			});
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as net.AddressInfo;
		const handle = connectBrowserRuntime(
			{ host: address.address, port: address.port },
			{
				execute: async () => {
					throw { code: "STALE_REFERENCE", message: "snapshot again" };
				},
			},
		);
		handles.push(handle);
		await vi.waitFor(() => expect(handle.connected).toBe(true));
		serverSocket!.write(`${JSON.stringify({ type: "command", requestId: "r2", sessionId: "s1", action: "click" })}\n`);
		await vi.waitFor(() =>
			expect(messages).toContainEqual({
				type: "result",
				requestId: "r2",
				ok: false,
				error: { code: "STALE_REFERENCE", message: "snapshot again" },
			}),
		);
	});
});
