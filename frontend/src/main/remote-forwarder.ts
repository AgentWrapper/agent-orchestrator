import http from "node:http";
import type net from "node:net";
import { once } from "node:events";
import type { RemoteServerConfigInput } from "./remote-server-config";

export type RemoteForwarder = {
	port: number;
	close(): Promise<void>;
};

const unavailableBody = JSON.stringify({ message: "Remote AO daemon is unavailable." });
const connectTimeoutMs = 5_000;
const hopByHopHeaders = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

function upstreamHeaders(
	headers: http.IncomingHttpHeaders,
	config: RemoteServerConfigInput,
	preserveUpgrade = false,
): http.OutgoingHttpHeaders {
	const connectionTokens = new Set(
		(Array.isArray(headers.connection) ? headers.connection.join(",") : (headers.connection ?? ""))
			.split(",")
			.map((token) => token.trim().toLowerCase())
			.filter(Boolean),
	);
	const forwarded: http.OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		if (value === undefined || hopByHopHeaders.has(lower) || connectionTokens.has(lower)) continue;
		forwarded[lower] = value;
	}
	if (preserveUpgrade && headers.upgrade) {
		forwarded.connection = "Upgrade";
		forwarded.upgrade = headers.upgrade;
	}
	forwarded.host = `${config.host}:${config.port}`;
	forwarded.authorization = `Bearer ${config.password}`;
	return forwarded;
}

function responseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
	const connectionTokens = new Set(
		(Array.isArray(headers.connection) ? headers.connection.join(",") : (headers.connection ?? ""))
			.split(",")
			.map((token) => token.trim().toLowerCase())
			.filter(Boolean),
	);
	const forwarded: http.OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		if (value === undefined || hopByHopHeaders.has(lower) || connectionTokens.has(lower)) continue;
		forwarded[lower] = value;
	}
	return forwarded;
}

function writeUnavailable(response: http.ServerResponse): void {
	if (response.destroyed) return;
	if (response.headersSent) {
		response.destroy();
		return;
	}
	response.writeHead(502, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(unavailableBody),
	});
	response.end(unavailableBody);
}

function rawResponseHead(response: http.IncomingMessage): string {
	const status = `HTTP/${response.httpVersion} ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}`;
	const headers: string[] = [];
	for (let i = 0; i < response.rawHeaders.length; i += 2) {
		headers.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
	}
	return `${status}\r\n${headers.join("\r\n")}\r\n\r\n`;
}

export async function startRemoteForwarder(config: RemoteServerConfigInput): Promise<RemoteForwarder> {
	const sockets = new Set<net.Socket>();
	const outboundRequests = new Set<http.ClientRequest>();
	const trackOutboundRequest = (request: http.ClientRequest): http.ClientRequest => {
		outboundRequests.add(request);
		let connectTimer: NodeJS.Timeout | undefined;
		const clearConnectTimer = () => {
			if (connectTimer) clearTimeout(connectTimer);
			connectTimer = undefined;
		};
		request.once("socket", (socket) => {
			if (!socket.connecting) return;
			connectTimer = setTimeout(() => {
				request.destroy(new Error("Remote AO daemon connection timed out."));
			}, connectTimeoutMs);
			socket.once("connect", clearConnectTimer);
			socket.once("error", clearConnectTimer);
			socket.once("close", clearConnectTimer);
		});
		request.once("error", clearConnectTimer);
		request.once("close", () => {
			clearConnectTimer();
			outboundRequests.delete(request);
		});
		return request;
	};
	const server = http.createServer((request, response) => {
		const upstream = trackOutboundRequest(http.request({
			hostname: config.host,
			port: config.port,
			method: request.method,
			path: request.url,
			headers: upstreamHeaders(request.headers, config),
		}));
		const cancelUpstream = () => upstream.destroy();
		request.once("aborted", cancelUpstream);
		response.once("close", () => {
			if (!response.writableFinished) cancelUpstream();
		});
		upstream.on("response", (upstreamResponse) => {
			const destroyDownstream = (error?: Error) => {
				if (response.destroyed) return;
				response.once("error", () => undefined);
				response.destroy(error ?? new Error("Remote AO daemon response aborted."));
			};
			upstreamResponse.once("aborted", () => destroyDownstream());
			upstreamResponse.once("error", destroyDownstream);
			response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers));
			if (upstreamResponse.headers["content-type"]?.startsWith("text/event-stream")) {
				response.flushHeaders();
			}
			upstreamResponse.pipe(response);
		});
		upstream.on("error", () => writeUnavailable(response));
		request.pipe(upstream);
	});

	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});

	server.on("upgrade", (request, clientSocket, clientHead) => {
		const upstream = trackOutboundRequest(http.request({
			hostname: config.host,
			port: config.port,
			method: request.method,
			path: request.url,
			headers: upstreamHeaders(request.headers, config, true),
		}));
		upstream.once("upgrade", (response, upstreamSocket, upstreamHead) => {
			sockets.add(upstreamSocket);
			upstreamSocket.once("close", () => sockets.delete(upstreamSocket));
			clientSocket.once("end", () => upstreamSocket.end());
			upstreamSocket.once("end", () => clientSocket.end());
			clientSocket.once("close", () => upstreamSocket.destroy());
			upstreamSocket.once("close", () => clientSocket.destroy());
			clientSocket.once("error", () => upstreamSocket.destroy());
			upstreamSocket.once("error", () => clientSocket.destroy());
			clientSocket.write(rawResponseHead(response));
			if (upstreamHead.length) clientSocket.write(upstreamHead);
			if (clientHead.length) upstreamSocket.write(clientHead);
			clientSocket.pipe(upstreamSocket).pipe(clientSocket);
		});
		upstream.once("response", (response) => {
			response.once("aborted", () => clientSocket.destroy());
			response.once("error", () => clientSocket.destroy());
			clientSocket.write(rawResponseHead(response));
			response.pipe(clientSocket);
		});
		upstream.once("error", () => {
			clientSocket.end(
				"HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\n" +
					`Content-Length: ${Buffer.byteLength(unavailableBody)}\r\n\r\n${unavailableBody}`,
			);
		});
		upstream.end();
	});

	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw new Error("Remote forwarder did not bind a TCP port");
	}

	return {
		port: address.port,
		close: async () => {
			for (const request of outboundRequests) request.destroy();
			for (const socket of sockets) socket.destroy();
			if (!server.listening) return;
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}
