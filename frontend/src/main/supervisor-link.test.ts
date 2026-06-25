// @vitest-environment node
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { connectSupervisor, type SupervisorLinkHandle } from "./supervisor-link";

// Bounded wait: resolves when the promise resolves, rejects after timeoutMs.
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), timeoutMs);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

function tmpSocketPath(): string {
	return path.join(os.tmpdir(), `ao-svlink-test-${process.pid}-${Date.now()}.sock`);
}

// Promisify: resolves the next time server.on("connection") fires.
function nextConnection(server: net.Server): Promise<net.Socket> {
	return new Promise((resolve) => {
		server.once("connection", resolve);
	});
}

describe("supervisor-link", () => {
	const handles: SupervisorLinkHandle[] = [];
	const servers: net.Server[] = [];

	afterEach(async () => {
		for (const h of handles.splice(0)) h.dispose();
		await Promise.all(
			servers.splice(0).map(
				(s) =>
					new Promise<void>((resolve) => {
						s.close(() => resolve());
					}),
			),
		);
	});

	it("retries until connected: connects after server is started later", async () => {
		const addr = tmpSocketPath();

		// Start the link BEFORE the server exists.
		const link = connectSupervisor(addr, { log: () => undefined });
		handles.push(link);

		// Wait a bit so a few retry attempts have fired against a missing socket.
		await new Promise<void>((r) => setTimeout(r, 400));

		// Now start the server.
		const server = net.createServer();
		servers.push(server);
		const connectionPromise = nextConnection(server);
		await new Promise<void>((resolve, reject) => {
			server.listen(addr, () => resolve());
			server.once("error", reject);
		});

		// The link should reconnect and the server should receive a connection.
		const conn = await withTimeout(connectionPromise, 5_000, "retry-until-connected: server did not receive connection");
		expect(conn).toBeTruthy();
		conn.destroy();
	});

	it("reconnects on drop: re-establishes after the accepted socket is closed", async () => {
		const addr = tmpSocketPath();

		// Start server first.
		const server = net.createServer();
		servers.push(server);

		let connectionCount = 0;
		const secondConnection = new Promise<net.Socket>((resolve) => {
			let first = true;
			server.on("connection", (sock) => {
				connectionCount++;
				if (first) {
					first = false;
					// Close the first accepted socket to simulate a drop.
					setTimeout(() => sock.destroy(), 50);
				} else {
					resolve(sock);
				}
			});
		});

		await new Promise<void>((resolve, reject) => {
			server.listen(addr, () => resolve());
			server.once("error", reject);
		});

		// Connect after server is up.
		const link = connectSupervisor(addr, { log: () => undefined });
		handles.push(link);

		// Wait for both the initial connection and the reconnect.
		const reconn = await withTimeout(secondConnection, 6_000, "reconnect-on-drop: second connection never arrived");
		expect(connectionCount).toBeGreaterThanOrEqual(2);
		reconn.destroy();
	});

	it("dispose stops reconnect: no connection arrives after dispose", async () => {
		const addr = tmpSocketPath();

		// Start link against a missing socket (no server), then dispose quickly.
		const link = connectSupervisor(addr, { log: () => undefined });

		// Dispose before the server exists.
		link.dispose();

		// Start a server and assert no connection arrives within a bounded window.
		const server = net.createServer();
		servers.push(server);
		let receivedConnection = false;
		server.on("connection", () => {
			receivedConnection = true;
		});
		await new Promise<void>((resolve, reject) => {
			server.listen(addr, () => resolve());
			server.once("error", reject);
		});

		// Wait long enough for at least one retry cycle to have run if dispose failed.
		await new Promise<void>((r) => setTimeout(r, 600));

		expect(receivedConnection).toBe(false);
	});
});
