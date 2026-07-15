// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { startRemoteForwarder, type RemoteForwarder } from "./remote-forwarder";

async function listen(server: net.Server): Promise<number> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind TCP");
	return address.port;
}

async function closeServer(server: net.Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function socketEnded(socket: net.Socket): Promise<true> {
	return new Promise((resolve) => {
		socket.once("end", () => resolve(true));
		socket.once("close", () => resolve(true));
	});
}

describe("remote-forwarder", () => {
	const servers: net.Server[] = [];
	const forwarders: RemoteForwarder[] = [];

	afterEach(async () => {
		await Promise.all(forwarders.splice(0).map((forwarder) => forwarder.close()));
		await Promise.all(servers.splice(0).map(closeServer));
	});

	it("forwards HTTP requests and injects the existing bearer password", async () => {
		let received:
			| { method?: string; url?: string; origin?: string; authorization?: string; host?: string; body: string }
			| undefined;
		const upstream = http.createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
			req.on("end", () => {
				received = {
					method: req.method,
					url: req.url,
					origin: req.headers.origin,
					authorization: req.headers.authorization,
					host: req.headers.host,
					body: Buffer.concat(chunks).toString("utf8"),
				};
				res.writeHead(201, { "content-type": "application/json", "x-upstream": "yes" });
				res.end('{"ok":true}');
			});
		});
		servers.push(upstream);
		const upstreamPort = await listen(upstream);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: upstreamPort, password: "test-password" });
		forwarders.push(forwarder);

		const response = await fetch(`http://127.0.0.1:${forwarder.port}/api/v1/sessions?view=all`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "app://renderer" },
			body: '{"prompt":"ship"}',
		});

		expect(response.status).toBe(201);
		expect(response.headers.get("x-upstream")).toBe("yes");
		expect(await response.text()).toBe('{"ok":true}');
		expect(received).toEqual({
			method: "POST",
			url: "/api/v1/sessions?view=all",
			origin: "app://renderer",
			authorization: "Bearer test-password",
			host: `127.0.0.1:${upstreamPort}`,
			body: '{"prompt":"ship"}',
		});
	});

	it("strips hop-by-hop request headers named directly and by Connection", async () => {
		let received: http.IncomingHttpHeaders | undefined;
		const upstream = http.createServer((req, res) => {
			received = req.headers;
			res.end("ok");
		});
		servers.push(upstream);
		const upstreamPort = await listen(upstream);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: upstreamPort, password: "test-password" });
		forwarders.push(forwarder);

		await new Promise<void>((resolve, reject) => {
			const client = net.connect(forwarder.port, "127.0.0.1");
			client.once("error", reject);
			client.once("end", resolve);
			client.once("connect", () => {
				client.write(
					"GET /headers HTTP/1.1\r\n" +
						`Host: 127.0.0.1:${forwarder.port}\r\n` +
						"Connection: close, x-remove-me\r\n" +
						"X-Remove-Me: secret\r\n" +
						"Keep-Alive: timeout=5\r\n" +
						"Proxy-Authenticate: Basic challenge\r\n" +
						"Proxy-Authorization: Basic secret\r\n" +
						"TE: trailers\r\n" +
						"Trailer: X-Trailer\r\n" +
						"Transfer-Encoding: chunked\r\n" +
						"Upgrade: websocket\r\n" +
						"X-Preserved: yes\r\n\r\n0\r\n\r\n",
				);
			});
			client.resume();
		});

		expect(received?.["x-preserved"]).toBe("yes");
		expect(received?.["x-remove-me"]).toBeUndefined();
		expect(received?.["keep-alive"]).toBeUndefined();
		expect(received?.["proxy-authenticate"]).toBeUndefined();
		expect(received?.["proxy-authorization"]).toBeUndefined();
		expect(received?.te).toBeUndefined();
		expect(received?.trailer).toBeUndefined();
		expect(received?.["transfer-encoding"]).toBeUndefined();
		expect(received?.upgrade).toBeUndefined();
		expect(received?.connection).not.toContain("x-remove-me");
	});

	it("streams SSE data before the upstream response ends", async () => {
		let finishUpstream: (() => void) | undefined;
		const upstream = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.write("event: ready\ndata: now\n\n");
			finishUpstream = () => res.end("event: done\ndata: later\n\n");
		});
		servers.push(upstream);
		const upstreamPort = await listen(upstream);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: upstreamPort, password: "test-password" });
		forwarders.push(forwarder);

		const response = await fetch(`http://127.0.0.1:${forwarder.port}/api/v1/events`);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing response stream");
		const first = await reader.read();

		expect(new TextDecoder().decode(first.value)).toContain("event: ready");
		expect(first.done).toBe(false);
		finishUpstream?.();
		await reader.cancel();
	});

	it("forwards SSE response headers before the first event", async () => {
		let finishUpstream: (() => void) | undefined;
		const upstream = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
			res.flushHeaders();
			finishUpstream = () => res.end();
			setTimeout(() => res.end(), 500);
		});
		servers.push(upstream);
		const upstreamPort = await listen(upstream);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: upstreamPort, password: "test-password" });
		forwarders.push(forwarder);

		const response = await Promise.race([
			fetch(`http://127.0.0.1:${forwarder.port}/api/v1/events`),
			new Promise<never>((_resolve, reject) =>
				setTimeout(() => reject(new Error("SSE response headers were buffered")), 250),
			),
		]);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		finishUpstream?.();
		await response.body?.cancel();
	});

	it("destroys the downstream SSE response when the upstream fails midstream", async () => {
		let failUpstream: (() => void) | undefined;
		const upstream = http.createServer((_req, res) => {
			res.on("error", () => undefined);
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write("event: ready\ndata: now\n\n");
			failUpstream = () => res.destroy(new Error("upstream stream failed"));
		});
		servers.push(upstream);
		const upstreamPort = await listen(upstream);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: upstreamPort, password: "test-password" });
		forwarders.push(forwarder);

		const response = await fetch(`http://127.0.0.1:${forwarder.port}/api/v1/events`);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing response stream");
		expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");
		failUpstream?.();

		const destroyed = await Promise.race([
			reader.read().then(() => false, () => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
		]);
		await reader.cancel().catch(() => undefined);
		expect(destroyed).toBe(true);
	});

	it("cancels a blackholed upstream request when the forwarder closes", async () => {
		let upstreamSocket: net.Socket | undefined;
		let acceptUpstream: () => void = () => undefined;
		const accepted = new Promise<void>((resolve) => { acceptUpstream = resolve; });
		const blackhole = net.createServer((socket) => {
			upstreamSocket = socket;
			socket.resume();
			acceptUpstream();
		});
		servers.push(blackhole);
		const upstreamPort = await listen(blackhole);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: upstreamPort, password: "test-password" });
		forwarders.push(forwarder);
		const request = http.get(`http://127.0.0.1:${forwarder.port}/healthz`);
		request.on("error", () => undefined);
		await accepted;
		const upstreamClosed = socketEnded(upstreamSocket!);

		await forwarder.close();
		const closed = await Promise.race([upstreamClosed, new Promise<false>((resolve) => setTimeout(() => resolve(false), 250))]);
		upstreamSocket?.destroy();

		expect(closed).toBe(true);
	});

	it("cancels the upstream request when the downstream request is aborted", async () => {
		let upstreamRequest: http.IncomingMessage | undefined;
		let receiveUpstream: () => void = () => undefined;
		const received = new Promise<void>((resolve) => { receiveUpstream = resolve; });
		const upstream = http.createServer((request) => {
			upstreamRequest = request;
			receiveUpstream();
		});
		servers.push(upstream);
		const upstreamPort = await listen(upstream);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: upstreamPort, password: "test-password" });
		forwarders.push(forwarder);
		const request = http.get(`http://127.0.0.1:${forwarder.port}/healthz`);
		request.on("error", () => undefined);
		await received;
		const upstreamClosed = once(upstreamRequest!, "aborted").then(() => true);

		request.destroy();
		const closed = await Promise.race([upstreamClosed, new Promise<false>((resolve) => setTimeout(() => resolve(false), 250))]);
		upstream.closeAllConnections();

		expect(closed).toBe(true);
	});

	it("cancels a pending WebSocket upgrade when the client disconnects", async () => {
		let upstreamSocket: net.Socket | undefined;
		let acceptUpstream: () => void = () => undefined;
		const accepted = new Promise<void>((resolve) => { acceptUpstream = resolve; });
		const blackhole = net.createServer((socket) => {
			upstreamSocket = socket;
			socket.resume();
			acceptUpstream();
		});
		servers.push(blackhole);
		const upstreamPort = await listen(blackhole);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: upstreamPort, password: "test-password" });
		forwarders.push(forwarder);
		const client = net.connect(forwarder.port, "127.0.0.1");
		await once(client, "connect");
		client.write(
			"GET /mux HTTP/1.1\r\n" +
				`Host: 127.0.0.1:${forwarder.port}\r\n` +
				"Connection: Upgrade\r\n" +
				"Upgrade: websocket\r\n" +
				"Sec-WebSocket-Version: 13\r\n" +
				"Sec-WebSocket-Key: dGVzdC1rZXk=\r\n\r\n",
		);
		await accepted;
		const upstreamClosed = socketEnded(upstreamSocket!);

		client.destroy();
		const closed = await Promise.race([upstreamClosed, new Promise<false>((resolve) => setTimeout(() => resolve(false), 250))]);
		upstreamSocket?.destroy();

		expect(closed).toBe(true);
	});

	it("injects auth into WebSocket upgrades and pipes bytes bidirectionally", async () => {
		let authorization: string | undefined;
		let resolveUpstreamEnded: () => void = () => undefined;
		const upstreamEnded = new Promise<void>((resolve) => {
			resolveUpstreamEnded = resolve;
		});
		const upstream = http.createServer();
		upstream.on("upgrade", (req, socket, head) => {
			authorization = req.headers.authorization;
			socket.once("end", () => {
				resolveUpstreamEnded();
				socket.end();
			});
			socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
			if (head.length) socket.write(head);
			socket.write("server-bytes");
			socket.on("data", (chunk) => socket.write(`echo:${chunk.toString("utf8")}`));
		});
		servers.push(upstream);
		const upstreamPort = await listen(upstream);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: upstreamPort, password: "test-password" });
		forwarders.push(forwarder);

		const client = net.connect(forwarder.port, "127.0.0.1");
		await once(client, "connect");
		client.write(
			"GET /mux HTTP/1.1\r\n" +
				`Host: 127.0.0.1:${forwarder.port}\r\n` +
				"Connection: Upgrade\r\n" +
				"Upgrade: websocket\r\n" +
				"Sec-WebSocket-Version: 13\r\n" +
				"Sec-WebSocket-Key: dGVzdC1rZXk=\r\n\r\n",
		);

		let data = "";
		client.on("data", (chunk) => {
			data += chunk.toString("utf8");
		});
		await new Promise<void>((resolve) => {
			const check = () => (data.includes("server-bytes") ? resolve() : setTimeout(check, 5));
			check();
		});
		client.write("client-bytes");
		await new Promise<void>((resolve) => {
			const check = () => (data.includes("echo:client-bytes") ? resolve() : setTimeout(check, 5));
			check();
		});

		expect(authorization).toBe("Bearer test-password");
		expect(data).toContain("101 Switching Protocols");
		client.destroy();
		await Promise.race([
			upstreamEnded,
			new Promise<never>((_resolve, reject) =>
				setTimeout(() => reject(new Error("upstream WebSocket did not receive end")), 500),
			),
		]);
	});

	it("returns 502 when the upstream cannot be reached", async () => {
		const unavailable = net.createServer();
		const port = await new Promise<number>((resolve) => {
			unavailable.listen(0, "127.0.0.1", () => {
				const address = unavailable.address();
				if (!address || typeof address === "string") throw new Error("server did not bind TCP");
				resolve(address.port);
			});
		});
		await new Promise<void>((resolve) => unavailable.close(() => resolve()));
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port, password: "test-password" });
		forwarders.push(forwarder);

		const response = await fetch(`http://127.0.0.1:${forwarder.port}/healthz`);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ message: "Remote AO daemon is unavailable." });
	});
});
