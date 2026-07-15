import http from "node:http";
import type net from "node:net";
import { once } from "node:events";
import type { RemoteServerConfigInput } from "./remote-server-config";

export type RemoteForwarder = {
	port: number;
	close(): Promise<void>;
};

const unavailableBody = JSON.stringify({ message: "Remote AO daemon is unavailable." });

function upstreamHeaders(
	headers: http.IncomingHttpHeaders,
	config: RemoteServerConfigInput,
): http.OutgoingHttpHeaders {
	return {
		...headers,
		host: `${config.host}:${config.port}`,
		authorization: `Bearer ${config.password}`,
	};
}

function writeUnavailable(response: http.ServerResponse): void {
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
	const server = http.createServer((request, response) => {
		const upstream = http.request({
			hostname: config.host,
			port: config.port,
			method: request.method,
			path: request.url,
			headers: upstreamHeaders(request.headers, config),
		});
		upstream.on("response", (upstreamResponse) => {
			response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
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
		const upstream = http.request({
			hostname: config.host,
			port: config.port,
			method: request.method,
			path: request.url,
			headers: upstreamHeaders(request.headers, config),
		});
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
			for (const socket of sockets) socket.destroy();
			if (!server.listening) return;
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}
