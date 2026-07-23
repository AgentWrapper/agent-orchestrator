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

async function forwarderRequest(
	forwarder: RemoteForwarder,
	localURL: string,
	options: { method?: string; headers?: http.OutgoingHttpHeaders; body?: string | string[] } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
	const local = new URL(localURL);
	return new Promise((resolve, reject) => {
		const request = http.request(
			{
				host: "127.0.0.1",
				port: forwarder.port,
				method: options.method,
				path: `${local.pathname}${local.search}`,
				headers: { host: local.host, ...options.headers },
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.once("end", () => {
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});
			},
		);
		request.once("error", reject);
		for (const chunk of Array.isArray(options.body) ? options.body : [options.body ?? ""]) request.write(chunk);
		request.end();
	});
}

describe("remote-forwarder", () => {
	const servers: net.Server[] = [];
	const forwarders: RemoteForwarder[] = [];

	afterEach(async () => {
		await Promise.all(forwarders.splice(0).map((forwarder) => forwarder.close()));
		await Promise.all(servers.splice(0).map(closeServer));
	});

	it("maps only local HTTP and absolute file previews to opaque origins", async () => {
		const upstream = http.createServer((_req, res) => res.end("ok"));
		servers.push(upstream);
		const upstreamPort = await listen(upstream);
		const forwarder = await startRemoteForwarder({
			host: "127.0.0.1",
			port: upstreamPort,
			password: "do-not-expose-this-password",
		});
		forwarders.push(forwarder);

		const targets = [
			"http://localhost:5173/app/page?mode=preview#selected",
			"https://127.0.0.1:8443/secure",
			"http://[::1]:3000/ipv6",
			"http://0.0.0.0:4173/unspecified-v4",
			"http://[::]:4174/unspecified-v6",
			"file:///home/remote/workspace/private/index.html?theme=dark#hero",
		];

		for (const [index, target] of targets.entries()) {
			const local = forwarder.resolvePreviewURL(`owner-${index}`, "session/one", target);
			const parsed = new URL(local);
			expect(parsed.protocol).toBe("http:");
			expect(parsed.hostname).toMatch(/^[a-f0-9]+\.ao-preview\.localhost$/);
			expect(parsed.port).toBe(String(forwarder.port));
			expect(local).not.toContain("localhost:5173");
			expect(local).not.toContain("/home/remote/workspace/private/");
			expect(local).not.toContain("do-not-expose-this-password");
		}

		const fileLocal = new URL(forwarder.resolvePreviewURL("file-owner", "session-one", targets.at(-1)!));
		expect(fileLocal.pathname).toBe("/index.html");
		expect(fileLocal.search).toBe("?theme=dark");
		expect(fileLocal.hash).toBe("#hero");
	});

	it.each([
		"https://example.com/app",
		"http://10.1.2.3:3000/app",
		"http://172.16.4.5/app",
		"http://192.168.1.30/app",
		"http://169.254.169.254/latest/meta-data",
	])("leaves non-loopback HTTP target direct: %s", async (target) => {
		const upstream = http.createServer((_req, res) => res.end("ok"));
		servers.push(upstream);
		const upstreamPort = await listen(upstream);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: upstreamPort, password: "secret" });
		forwarders.push(forwarder);

		expect(forwarder.resolvePreviewURL("owner", "session", target)).toBe(target);
	});

	it("reuses an owner mapping for the same session and target origin", async () => {
		const upstream = http.createServer((_req, res) => res.end("ok"));
		servers.push(upstream);
		const upstreamPort = await listen(upstream);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: upstreamPort, password: "secret" });
		forwarders.push(forwarder);

		const first = new URL(
			forwarder.resolvePreviewURL("renderer:7/view:one", "session-one", "http://localhost:5173/first?q=1#one"),
		);
		const second = new URL(
			forwarder.resolvePreviewURL("renderer:7/view:one", "session-one", "http://localhost:5173/second?q=2#two"),
		);

		expect(second.origin).toBe(first.origin);
		expect(second.pathname).toBe("/second");
		expect(second.search).toBe("?q=2");
		expect(second.hash).toBe("#two");
		expect(forwarder.originalPreviewURL(second.toString())).toBe("http://localhost:5173/second?q=2#two");
		const otherOwner = new URL(
			forwarder.resolvePreviewURL("renderer:8/view:one", "session-one", "http://localhost:5173/second"),
		);
		expect(otherOwner.origin).not.toBe(first.origin);
	});

	it("translates file aliases and invalidates all mappings owned by a released view", async () => {
		const upstream = http.createServer((_req, res) => res.end("ok"));
		servers.push(upstream);
		const upstreamPort = await listen(upstream);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: upstreamPort, password: "secret" });
		forwarders.push(forwarder);
		const target = "file:///home/remote/workspace/docs/guide.html?lang=en#intro";
		const local = forwarder.resolvePreviewURL("renderer:7/view:one", "session-one", target);
		forwarder.resolvePreviewURL("renderer:7/view:one", "session-one", "http://127.0.0.1:4173/app");

		expect(forwarder.originalPreviewURL(local)).toBe(target);
		forwarder.releasePreview("renderer:7/view:one");
		expect(forwarder.originalPreviewURL(local)).toBe(local);

		const closeTarget = "http://localhost:5173/after-close";
		const closeLocal = forwarder.resolvePreviewURL("renderer:8/view:two", "session-two", closeTarget);
		await forwarder.close();
		expect(forwarder.originalPreviewURL(closeLocal)).toBe(closeLocal);
	});

	it("routes preview HTTP through the daemon with owned headers and streamed bodies", async () => {
		let received:
			| {
				method?: string;
				url?: string;
				target?: string;
				authorization?: string;
				upstreamAuthorization?: string;
				host?: string;
				origin?: string;
				forged?: string;
				body: string;
			  }
			| undefined;
		const daemon = http.createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
			req.on("end", () => {
				received = {
					method: req.method,
					url: req.url,
					target: req.headers["x-ao-preview-target"] as string | undefined,
					authorization: req.headers.authorization,
					upstreamAuthorization: req.headers["x-ao-preview-upstream-authorization"] as string | undefined,
					host: req.headers.host,
					origin: req.headers.origin,
					forged: req.headers["x-ao-preview-forged"] as string | undefined,
					body: Buffer.concat(chunks).toString("utf8"),
				};
				res.writeHead(201, {
					"content-type": "text/plain",
					"x-ao-preview-upstream-authorization": "remove-me",
				});
				res.write("response-");
				res.end("body");
			});
		});
		servers.push(daemon);
		const daemonPort = await listen(daemon);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: daemonPort, password: "remote-secret" });
		forwarders.push(forwarder);
		const local = forwarder.resolvePreviewURL(
			"renderer:7/view:one",
			"session/with spaces",
			"http://0.0.0.0:5173/api/a%2Fb?color=deep%20blue#ignored",
		);

		const response = await forwarderRequest(forwarder, local, {
			method: "PATCH",
			headers: {
				authorization: "Basic dXNlcjpwYXNz",
				origin: new URL(local).origin,
				"x-ao-preview-target": "http://127.0.0.1:1",
				"x-ao-preview-upstream-authorization": "Bearer forged-secret",
				"x-ao-preview-forged": "caller-controlled",
				"content-type": "text/plain",
			},
			body: ["request-", "body"],
		});

		expect(response.status).toBe(201);
		expect(response.body).toBe("response-body");
		expect(response.headers["x-ao-preview-upstream-authorization"]).toBeUndefined();
		expect(received).toEqual({
			method: "PATCH",
			url: "/_ao/preview/session%2Fwith%20spaces/api/a%2Fb?color=deep%20blue",
			target: "http://127.0.0.1:5173",
			authorization: "Bearer remote-secret",
			upstreamAuthorization: "Basic dXNlcjpwYXNz",
			host: `127.0.0.1:${daemonPort}`,
			origin: undefined,
			forged: undefined,
			body: "request-body",
		});
	});

	it("drops forged preview authorization metadata when the browser has no authorization", async () => {
		let received:
			| { authorization?: string; upstreamAuthorization?: string; forgedUpstreamAuth?: string }
			| undefined;
		const daemon = http.createServer((req, res) => {
			received = {
				authorization: req.headers.authorization,
				upstreamAuthorization: req.headers["x-ao-preview-upstream-authorization"] as string | undefined,
				forgedUpstreamAuth: req.headers["x-ao-preview-upstream-auth"] as string | undefined,
			};
			res.end("ok");
		});
		servers.push(daemon);
		const daemonPort = await listen(daemon);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: daemonPort, password: "remote-secret" });
		forwarders.push(forwarder);
		const local = forwarder.resolvePreviewURL("owner", "session", "http://localhost:5173/private");

		await forwarderRequest(forwarder, local, {
			headers: {
				"x-ao-preview-upstream-authorization": "Basic forged-secret",
				"x-ao-preview-upstream-auth": "Bearer forged-secret",
			},
		});

		expect(received).toEqual({
			authorization: "Bearer remote-secret",
			upstreamAuthorization: undefined,
			forgedUpstreamAuth: undefined,
		});
	});

	it("streams preview response data before the daemon response ends", async () => {
		let finishResponse: (() => void) | undefined;
		const daemon = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write("event: ready\ndata: first\n\n");
			finishResponse = () => res.end("event: done\ndata: last\n\n");
		});
		servers.push(daemon);
		const daemonPort = await listen(daemon);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: daemonPort, password: "secret" });
		forwarders.push(forwarder);
		const local = new URL(
			forwarder.resolvePreviewURL("owner", "session", "http://localhost:5173/events"),
		);

		const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
			const request = http.get(
				{
					host: "127.0.0.1",
					port: forwarder.port,
					path: local.pathname,
					headers: { host: local.host },
				},
				resolve,
			);
			request.once("error", reject);
		});
		const first = await Promise.race([
			once(response, "data").then(([chunk]) => Buffer.from(chunk).toString("utf8")),
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("preview response was buffered")), 250)),
		]);

		expect(first).toContain("event: ready");
		finishResponse?.();
		response.resume();
		await once(response, "end");
	});

	it("sends the complete absolute file target while exposing only its basename", async () => {
		let receivedURL: string | undefined;
		let receivedTarget: string | undefined;
		const daemon = http.createServer((req, res) => {
			receivedURL = req.url;
			receivedTarget = req.headers["x-ao-preview-target"] as string | undefined;
			res.end("file");
		});
		servers.push(daemon);
		const daemonPort = await listen(daemon);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: daemonPort, password: "secret" });
		forwarders.push(forwarder);
		const local = forwarder.resolvePreviewURL(
			"owner",
			"session",
			"file:///home/remote/private%20workspace/docs/index.html?theme=dark#intro",
		);

		const response = await forwarderRequest(forwarder, local);

		expect(response.status).toBe(200);
		expect(receivedURL).toBe("/_ao/preview/session/index.html?theme=dark");
		expect(receivedTarget).toBe("file:///home/remote/private%20workspace/docs/index.html");
	});

	it("fails closed for unknown and released preview hosts", async () => {
		let daemonRequests = 0;
		const daemon = http.createServer((_req, res) => {
			daemonRequests++;
			res.end("daemon");
		});
		servers.push(daemon);
		const daemonPort = await listen(daemon);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: daemonPort, password: "secret" });
		forwarders.push(forwarder);
		const known = forwarder.resolvePreviewURL("owner", "session", "http://localhost:5173/app");
		const unknown = `http://unknown.ao-preview.localhost:${forwarder.port}/app`;

		expect((await forwarderRequest(forwarder, unknown)).status).toBe(404);
		forwarder.releasePreview("owner");
		expect((await forwarderRequest(forwarder, known)).status).toBe(404);
		expect(daemonRequests).toBe(0);
	});

	it("accepts only the exact preview Host grammar and fails namespace variants closed", async () => {
		let daemonRequests = 0;
		const daemon = http.createServer((_req, res) => {
			daemonRequests++;
			res.end("daemon");
		});
		servers.push(daemon);
		const daemonPort = await listen(daemon);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: daemonPort, password: "secret" });
		forwarders.push(forwarder);
		const known = new URL(forwarder.resolvePreviewURL("owner", "session", "http://localhost:5173/app"));
		const token = known.hostname.slice(0, known.hostname.indexOf("."));
		const unknownToken = `${token[0] === "0" ? "1" : "0"}${token.slice(1)}`;
		const requestHost = (host: string) =>
			forwarderRequest(forwarder, `http://127.0.0.1:${forwarder.port}/app`, { headers: { host } });
		const invalidHosts = [
			`${token}.ao-preview.localhost:${forwarder.port + 1}`,
			`${token}.ao-preview.localhost`,
			`${token}.ao-preview.localhost:0${forwarder.port}`,
			`${token}.ao-preview.localhost.:${forwarder.port}`,
			`user@${known.host}`,
			`${known.host}/path`,
			`${known.host}?query=1`,
			`${known.host}#fragment`,
			`not-hex.ao-preview.localhost:${forwarder.port}`,
			`${unknownToken}.ao-preview.localhost:${forwarder.port}`,
			`${unknownToken.toUpperCase()}.AO-PREVIEW.LOCALHOST:${forwarder.port}`,
			`${known.host}.example.com`,
		];

		for (const host of invalidHosts) {
			expect((await requestHost(host)).status, host).toBe(404);
		}
		expect(daemonRequests).toBe(0);

		expect((await requestHost(known.host.toUpperCase())).status).toBe(200);
		expect(daemonRequests).toBe(1);
	});

	it("rewrites preview redirects without mutating the active mapping", async () => {
		const receivedTargets: string[] = [];
		const daemon = http.createServer((req, res) => {
			receivedTargets.push(req.headers["x-ao-preview-target"] as string);
			switch (req.url) {
				case "/_ao/preview/session/start/relative":
					res.writeHead(302, { location: "../next?q=1#relative" });
					break;
				case "/_ao/preview/session/start/absolute":
					res.writeHead(302, { location: "http://localhost:5173/next?q=2#absolute" });
					break;
				case "/_ao/preview/session/start/cross":
					res.writeHead(302, {
						location: "http://127.0.0.1:43210/next?q=3#cross",
						"x-ao-preview-redirect-target": "http://127.0.0.1:43210",
					});
					break;
				case "/_ao/preview/session/start/protocol-relative":
					res.writeHead(302, {
						location: "//127.0.0.1:43210/next?q=4#protocol-relative",
						"x-ao-preview-redirect-target": "http://127.0.0.1:43210",
					});
					break;
				case "/_ao/preview/session/start/public":
					res.writeHead(302, { location: "https://example.com/next" });
					break;
				case "/_ao/preview/session/start/lan":
					res.writeHead(302, { location: "http://192.168.1.20/next" });
					break;
				default:
					res.writeHead(204);
			}
			res.end();
		});
		servers.push(daemon);
		const daemonPort = await listen(daemon);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: daemonPort, password: "secret" });
		forwarders.push(forwarder);
		const owner = "renderer:7/view:one";
		const localFor = (path: string) =>
			forwarder.resolvePreviewURL(owner, "session", `http://localhost:5173/start/${path}`);

		const relative = await forwarderRequest(forwarder, localFor("relative"));
		const absolute = await forwarderRequest(forwarder, localFor("absolute"));
		const cross = await forwarderRequest(forwarder, localFor("cross"));
		const protocolRelative = await forwarderRequest(forwarder, localFor("protocol-relative"));
		const directPublic = await forwarderRequest(forwarder, localFor("public"));
		const directLAN = await forwarderRequest(forwarder, localFor("lan"));

		const opaqueOrigin = new URL(localFor("relative")).origin;
		expect(relative.headers.location).toBe(`${opaqueOrigin}/next?q=1#relative`);
		expect(absolute.headers.location).toBe(`${opaqueOrigin}/next?q=2#absolute`);
		expect(directPublic.headers.location).toBe("https://example.com/next");
		expect(directLAN.headers.location).toBe("http://192.168.1.20/next");
		expect(cross.headers["x-ao-preview-redirect-target"]).toBeUndefined();
		const crossLocal = cross.headers.location!;
		expect(new URL(crossLocal).origin).not.toBe(opaqueOrigin);
		expect(forwarder.originalPreviewURL(crossLocal)).toBe("http://127.0.0.1:43210/next?q=3#cross");
		expect(protocolRelative.headers["x-ao-preview-redirect-target"]).toBeUndefined();
		const protocolRelativeLocal = protocolRelative.headers.location!;
		expect(new URL(protocolRelativeLocal).origin).not.toBe(opaqueOrigin);
		expect(forwarder.originalPreviewURL(protocolRelativeLocal)).toBe(
			"http://127.0.0.1:43210/next?q=4#protocol-relative",
		);

		await forwarderRequest(forwarder, crossLocal);
		await forwarderRequest(forwarder, localFor("still-current"));
		expect(receivedTargets.at(-2)).toBe("http://127.0.0.1:43210");
		expect(receivedTargets.at(-1)).toBe("http://localhost:5173");
	});

	it("strips preview cookie domains, LAN credentials, and internal response headers", async () => {
		const daemon = http.createServer((_req, res) => {
			res.writeHead(200, {
				"x-ao-preview-debug": "internal",
				"set-cookie": [
					"theme=dark; Domain=localhost; Path=/; HttpOnly",
					"ao_conn=remote-secret; Domain=remote.example; HttpOnly",
					"session=business; domain=.localhost; Secure; SameSite=None",
				],
			});
			res.end("ok");
		});
		servers.push(daemon);
		const daemonPort = await listen(daemon);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: daemonPort, password: "secret" });
		forwarders.push(forwarder);
		const local = forwarder.resolvePreviewURL("owner", "session", "http://localhost:5173/cookies");

		const response = await forwarderRequest(forwarder, local);

		expect(response.headers["x-ao-preview-debug"]).toBeUndefined();
		expect(response.headers["set-cookie"]).toEqual([
			"theme=dark; Path=/; HttpOnly",
			"session=business; Secure; SameSite=None",
		]);
	});

	it("routes preview WebSocket upgrades through the selected mapping", async () => {
		let received:
			| {
				url?: string;
				target?: string;
				authorization?: string;
				upstreamAuthorization?: string;
				host?: string;
				origin?: string;
				forged?: string;
			  }
			| undefined;
		const daemon = http.createServer();
		daemon.on("upgrade", (req, socket) => {
			received = {
				url: req.url,
				target: req.headers["x-ao-preview-target"] as string | undefined,
				authorization: req.headers.authorization,
				upstreamAuthorization: req.headers["x-ao-preview-upstream-authorization"] as string | undefined,
				host: req.headers.host,
				origin: req.headers.origin,
				forged: req.headers["x-ao-preview-forged"] as string | undefined,
			};
			socket.once("end", () => socket.end());
			socket.write(
				"HTTP/1.1 101 Switching Protocols\r\n" +
					"Connection: Upgrade\r\n" +
					"Upgrade: websocket\r\n" +
					"X-AO-Preview-Debug: internal\r\n" +
					"Set-Cookie: theme=dark; Domain=localhost; Path=/\r\n" +
					"Set-Cookie: ao_conn=remote-secret; HttpOnly\r\n\r\n",
			);
			socket.write("server-frame");
			socket.on("data", (chunk) => socket.write(`echo:${chunk.toString("utf8")}`));
		});
		servers.push(daemon);
		const daemonPort = await listen(daemon);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: daemonPort, password: "remote-secret" });
		forwarders.push(forwarder);
		const local = new URL(
			forwarder.resolvePreviewURL("renderer:7/view:one", "session/one", "http://localhost:5173/socket?room=blue"),
		);
		const client = net.connect(forwarder.port, "127.0.0.1");
		await once(client, "connect");
		client.write(
			`GET ${local.pathname}${local.search} HTTP/1.1\r\n` +
				`Host: ${local.host}\r\n` +
				"Connection: Upgrade\r\n" +
				"Upgrade: websocket\r\n" +
				"Sec-WebSocket-Version: 13\r\n" +
				"Sec-WebSocket-Key: dGVzdC1rZXk=\r\n" +
				`Origin: ${local.origin}\r\n` +
				"Authorization: Bearer caller-secret\r\n" +
				"X-AO-Preview-Target: http://127.0.0.1:1\r\n" +
				"X-AO-Preview-Upstream-Authorization: Basic forged-secret\r\n" +
				"X-AO-Preview-Forged: caller-controlled\r\n\r\n",
		);
		let data = "";
		client.on("data", (chunk) => {
			data += chunk.toString("utf8");
		});
		await new Promise<void>((resolve) => {
			const check = () => (data.includes("server-frame") ? resolve() : setTimeout(check, 5));
			check();
		});
		client.write("client-frame");
		await new Promise<void>((resolve) => {
			const check = () => (data.includes("echo:client-frame") ? resolve() : setTimeout(check, 5));
			check();
		});
		client.destroy();

		expect(received).toEqual({
			url: "/_ao/preview/session%2Fone/socket?room=blue",
			target: "http://localhost:5173",
			authorization: "Bearer remote-secret",
			upstreamAuthorization: "Bearer caller-secret",
			host: `127.0.0.1:${daemonPort}`,
			origin: undefined,
			forged: undefined,
		});
		expect(data).toContain("101 Switching Protocols");
		expect(data).not.toContain("X-AO-Preview-");
		expect(data).toContain("Set-Cookie: theme=dark; Path=/");
		expect(data).not.toContain("ao_conn=");
	});

	it("fails closed for unknown and released preview WebSocket hosts", async () => {
		let daemonUpgrades = 0;
		const daemon = http.createServer();
		daemon.on("upgrade", (_req, socket) => {
			daemonUpgrades++;
			socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
		});
		servers.push(daemon);
		const daemonPort = await listen(daemon);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: daemonPort, password: "secret" });
		forwarders.push(forwarder);
		const known = new URL(forwarder.resolvePreviewURL("owner", "session", "http://localhost:5173/socket"));
		const requestHost = async (host: string): Promise<string> => {
			const client = net.connect(forwarder.port, "127.0.0.1");
			await once(client, "connect");
			client.write(
				"GET /socket HTTP/1.1\r\n" +
					`Host: ${host}\r\n` +
					"Connection: Upgrade\r\n" +
					"Upgrade: websocket\r\n" +
					"Sec-WebSocket-Version: 13\r\n" +
					"Sec-WebSocket-Key: dGVzdC1rZXk=\r\n\r\n",
			);
			let response = "";
			client.on("data", (chunk) => {
				response += chunk.toString("utf8");
			});
			await new Promise<void>((resolve) => {
				const check = () => (response.includes("\r\n\r\n") ? resolve() : setTimeout(check, 5));
				check();
			});
			client.destroy();
			return response;
		};

		expect(await requestHost(`unknown.ao-preview.localhost:${forwarder.port}`)).toContain("404 Not Found");
		expect(await requestHost(`${known.hostname}.:${forwarder.port}`)).toContain("404 Not Found");
		forwarder.releasePreview("owner");
		expect(await requestHost(known.host)).toContain("404 Not Found");
		expect(daemonUpgrades).toBe(0);
	});

	it("applies preview redirect and cookie rules to non-101 WebSocket responses", async () => {
		const daemon = http.createServer();
		daemon.on("upgrade", (_req, socket) => {
			socket.end(
				"HTTP/1.1 302 Found\r\n" +
					"Location: http://127.0.0.1:43210/next?q=1#cross\r\n" +
					"X-AO-Preview-Redirect-Target: http://127.0.0.1:43210\r\n" +
					"X-AO-Preview-Debug: internal\r\n" +
					"Set-Cookie: theme=dark; Domain=localhost; Path=/\r\n" +
					"Set-Cookie: ao_conn=remote-secret; HttpOnly\r\n" +
					"Content-Length: 0\r\n" +
					"Connection: close\r\n\r\n",
			);
		});
		servers.push(daemon);
		const daemonPort = await listen(daemon);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: daemonPort, password: "secret" });
		forwarders.push(forwarder);
		const local = new URL(
			forwarder.resolvePreviewURL("renderer:7/view:one", "session", "http://localhost:5173/socket"),
		);
		const client = net.connect(forwarder.port, "127.0.0.1");
		await once(client, "connect");
		client.write(
			`GET ${local.pathname} HTTP/1.1\r\n` +
				`Host: ${local.host}\r\n` +
				"Connection: Upgrade\r\n" +
				"Upgrade: websocket\r\n" +
				"Sec-WebSocket-Version: 13\r\n" +
				"Sec-WebSocket-Key: dGVzdC1rZXk=\r\n\r\n",
		);
		let responseHead = "";
		client.on("data", (chunk) => {
			responseHead += chunk.toString("utf8");
		});
		await new Promise<void>((resolve) => {
			const check = () => (responseHead.includes("\r\n\r\n") ? resolve() : setTimeout(check, 5));
			check();
		});
		client.destroy();
		const location = /^Location: (.+)$/im.exec(responseHead)?.[1].trim();

		expect(responseHead).not.toContain("X-AO-Preview-");
		expect(responseHead).toContain("Set-Cookie: theme=dark; Path=/");
		expect(responseHead).not.toContain("ao_conn=");
		expect(location).toBeDefined();
		expect(new URL(location!).origin).not.toBe(local.origin);
		expect(forwarder.originalPreviewURL(location!)).toBe("http://127.0.0.1:43210/next?q=1#cross");
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

	it("strips only the LAN credential cookie from HTTP requests and responses", async () => {
		let receivedCookie: string | undefined;
		const upstream = http.createServer((req, res) => {
			receivedCookie = req.headers.cookie;
			res.writeHead(200, {
				"set-cookie": [
					"theme=light; Path=/",
					"ao_conn=rotated-secret; HttpOnly; SameSite=Strict",
					"session=business-session; Secure",
					"domain-cookie=preserved; Domain=remote.example; Path=/",
				],
			});
			res.end("ok");
		});
		servers.push(upstream);
		const upstreamPort = await listen(upstream);
		const forwarder = await startRemoteForwarder({ host: "127.0.0.1", port: upstreamPort, password: "test-password" });
		forwarders.push(forwarder);

		const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
			const request = http.get(
				{
					host: "127.0.0.1",
					port: forwarder.port,
					path: "/cookies",
					headers: { cookie: "theme=dark; ao_conn=browser-secret; session=business-session" },
				},
				resolve,
			);
			request.once("error", reject);
		});
		response.resume();
		await once(response, "end");

		expect(receivedCookie).toBe("theme=dark; session=business-session");
		expect(response.headers["set-cookie"]).toEqual([
			"theme=light; Path=/",
			"session=business-session; Secure",
			"domain-cookie=preserved; Domain=remote.example; Path=/",
		]);
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
			reader.read().then(
				() => false,
				() => true,
			),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
		]);
		await reader.cancel().catch(() => undefined);
		expect(destroyed).toBe(true);
	});

	it("cancels a blackholed upstream request when the forwarder closes", async () => {
		let upstreamSocket: net.Socket | undefined;
		let acceptUpstream: () => void = () => undefined;
		const accepted = new Promise<void>((resolve) => {
			acceptUpstream = resolve;
		});
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
		const closed = await Promise.race([
			upstreamClosed,
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
		]);
		upstreamSocket?.destroy();

		expect(closed).toBe(true);
	});

	it("cancels the upstream request when the downstream request is aborted", async () => {
		let upstreamRequest: http.IncomingMessage | undefined;
		let receiveUpstream: () => void = () => undefined;
		const received = new Promise<void>((resolve) => {
			receiveUpstream = resolve;
		});
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
		const closed = await Promise.race([
			upstreamClosed,
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
		]);
		upstream.closeAllConnections();

		expect(closed).toBe(true);
	});

	it("cancels a pending WebSocket upgrade when the client disconnects", async () => {
		let upstreamSocket: net.Socket | undefined;
		let acceptUpstream: () => void = () => undefined;
		const accepted = new Promise<void>((resolve) => {
			acceptUpstream = resolve;
		});
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
		const closed = await Promise.race([
			upstreamClosed,
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
		]);
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

	it("strips only the LAN credential cookie from a WebSocket upgrade response", async () => {
		const upstream = http.createServer();
		let upstreamSocket: { destroy(): void } | undefined;
		upstream.on("upgrade", (_req, socket) => {
			upstreamSocket = socket;
			socket.write(
				"HTTP/1.1 101 Switching Protocols\r\n" +
					"Connection: Upgrade\r\n" +
					"Upgrade: websocket\r\n" +
					"Set-Cookie: ao_conn=rotated-secret; HttpOnly\r\n" +
					"Set-Cookie: theme=dark; Path=/\r\n\r\n",
			);
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
		let responseHead = "";
		client.on("data", (chunk) => {
			responseHead += chunk.toString("utf8");
		});
		await new Promise<void>((resolve) => {
			const check = () => (responseHead.includes("\r\n\r\n") ? resolve() : setTimeout(check, 5));
			check();
		});
		client.destroy();
		upstreamSocket?.destroy();

		expect(responseHead).toContain("Set-Cookie: theme=dark; Path=/");
		expect(responseHead).not.toContain("ao_conn=");
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
		expect(await response.json()).toEqual({
			error: "unavailable",
			code: "REMOTE_DAEMON_UNAVAILABLE",
			message: "REMOTE_DAEMON_UNAVAILABLE",
		});
	});
});
