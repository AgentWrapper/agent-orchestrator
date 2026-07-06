#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST_DIR = path.resolve(HERE, "../frontend/dist");
const DEFAULT_TARGET = "http://127.0.0.1:3001";
const PROXY_PREFIXES = ["/api", "/healthz", "/readyz", "/mux"];

const CONTENT_TYPES = new Map([
	[".css", "text/css; charset=utf-8"],
	[".gif", "image/gif"],
	[".html", "text/html; charset=utf-8"],
	[".ico", "image/x-icon"],
	[".js", "text/javascript; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".map", "application/json; charset=utf-8"],
	[".png", "image/png"],
	[".svg", "image/svg+xml"],
	[".webp", "image/webp"],
	[".woff", "font/woff"],
	[".woff2", "font/woff2"],
]);

export function createAoWebServer(options = {}) {
	const distDir = path.resolve(options.distDir ?? process.env.AO_WEB_DIST ?? DEFAULT_DIST_DIR);
	const apiTarget = new URL(options.apiTarget ?? process.env.AO_WEB_API_TARGET ?? DEFAULT_TARGET);
	const publicUrl = options.publicUrl ?? process.env.AO_WEB_PUBLIC_URL ?? "";
	if (apiTarget.protocol !== "http:") {
		throw new Error(`AO_WEB_API_TARGET must be http:, got ${apiTarget.protocol}`);
	}
	const trust = buildTrustConfig(publicUrl);

	const server = http.createServer((request, response) => {
		void handleRequest({ apiTarget, distDir, request, response, trust });
	});
	server.on("upgrade", (request, socket, head) => {
		handleUpgrade({ apiTarget, head, request, socket, trust });
	});
	return server;
}

async function handleRequest({ apiTarget, distDir, request, response, trust }) {
	const url = requestUrl(request);
	if (!url) {
		writePlain(response, 400, "Bad request\n");
		return;
	}

	if (shouldProxy(url.pathname)) {
		if (!trustedBrowserRequest(request, trust)) {
			writePlain(response, 403, "Origin is not allowed\n");
			return;
		}
		proxyHttp({ apiTarget, request, response });
		return;
	}

	if (request.method !== "GET" && request.method !== "HEAD") {
		response.setHeader("Allow", "GET, HEAD");
		writePlain(response, 405, "Method not allowed\n");
		return;
	}

	await serveStatic({ distDir, pathname: url.pathname, request, response });
}

function proxyHttp({ apiTarget, request, response }) {
	const proxyRequest = http.request(
		{
			hostname: apiTarget.hostname,
			port: apiTarget.port || "80",
			method: request.method,
			path: request.url,
			headers: proxyHeaders(request.headers, apiTarget),
		},
		(proxyResponse) => {
			response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.statusMessage, proxyResponse.headers);
			proxyResponse.pipe(response);
		},
	);
	proxyRequest.on("error", (error) => {
		if (!response.headersSent) {
			writePlain(response, 502, `AO daemon proxy failed: ${error.message}\n`);
		} else {
			response.destroy(error);
		}
	});
	request.pipe(proxyRequest);
}

function handleUpgrade({ apiTarget, head, request, socket, trust }) {
	const url = requestUrl(request);
	if (!url || !shouldProxy(url.pathname)) {
		socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
		return;
	}
	if (!trustedBrowserRequest(request, trust)) {
		socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
		return;
	}

	const upstream = net.connect(Number(apiTarget.port || "80"), apiTarget.hostname);
	upstream.on("connect", () => {
		upstream.write(formatUpgradeRequest(request, apiTarget));
		if (head.length > 0) upstream.write(head);
		socket.pipe(upstream);
		upstream.pipe(socket);
	});
	upstream.on("error", () => {
		socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
	});
	socket.on("error", () => {
		upstream.destroy();
	});
}

async function serveStatic({ distDir, pathname, request, response }) {
	const filePath = await resolveStaticPath(distDir, pathname);
	if (!filePath) {
		writePlain(response, 404, "Not found\n");
		return;
	}

	const contentType = CONTENT_TYPES.get(path.extname(filePath)) ?? "application/octet-stream";
	response.setHeader("Content-Type", contentType);
	response.setHeader("X-Content-Type-Options", "nosniff");
	if (path.basename(filePath) === "index.html") {
		response.setHeader("Cache-Control", "no-store");
	} else {
		response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
	}
	if (request.method === "HEAD") {
		response.writeHead(200);
		response.end();
		return;
	}
	createReadStream(filePath)
		.on("error", () => {
			if (!response.headersSent) writePlain(response, 500, "Static file read failed\n");
			else response.destroy();
		})
		.pipe(response);
}

async function resolveStaticPath(distDir, pathname) {
	const decoded = safeDecodePath(pathname);
	if (decoded === null) return null;

	const directPath = safeJoin(distDir, decoded === "/" ? "/index.html" : decoded);
	const directFile = directPath ? await existingFile(directPath) : null;
	if (directFile) return directFile;
	if (isAssetRequest(decoded)) return null;

	const indexPath = safeJoin(distDir, "/index.html");
	return indexPath ? existingFile(indexPath) : null;
}

function isAssetRequest(pathname) {
	return pathname.startsWith("/assets/") || path.extname(pathname) !== "";
}

async function existingFile(filePath) {
	try {
		const info = await stat(filePath);
		if (info.isDirectory()) return existingFile(path.join(filePath, "index.html"));
		return info.isFile() ? filePath : null;
	} catch {
		return null;
	}
}

function safeJoin(root, pathname) {
	const candidate = path.resolve(root, `.${pathname}`);
	const relative = path.relative(root, candidate);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return candidate;
}

function safeDecodePath(pathname) {
	try {
		return decodeURIComponent(pathname);
	} catch {
		return null;
	}
}

function shouldProxy(pathname) {
	return PROXY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function requestUrl(request) {
	try {
		return new URL(request.url ?? "/", "http://ao-web.local");
	} catch {
		return null;
	}
}

function proxyHeaders(headers, apiTarget) {
	const next = {
		...headers,
		host: apiTarget.host,
	};
	delete next.origin;
	return next;
}

function formatUpgradeRequest(request, apiTarget) {
	const headers = proxyHeaders(request.headers, apiTarget);
	const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}`];
	for (const [name, value] of Object.entries(headers)) {
		if (Array.isArray(value)) {
			for (const entry of value) lines.push(`${name}: ${entry}`);
		} else if (value !== undefined) {
			lines.push(`${name}: ${value}`);
		}
	}
	return `${lines.join("\r\n")}\r\n\r\n`;
}

function writePlain(response, statusCode, body) {
	response.writeHead(statusCode, {
		"Content-Type": "text/plain; charset=utf-8",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(body);
}

function buildTrustConfig(publicUrl) {
	const publicOrigin = parseOrigin(publicUrl);
	const publicHost = publicOrigin ? new URL(publicOrigin).host : "";
	return { publicHost, publicOrigin };
}

function trustedBrowserRequest(request, trust) {
	if (!trustedHost(request.headers.host ?? "", trust)) return false;
	const origin = request.headers.origin;
	return typeof origin === "string" ? trustedOrigin(origin, trust) : true;
}

function trustedHost(hostHeader, trust) {
	const host = hostHeader.split(",")[0]?.trim() ?? "";
	if (host === "") return false;
	if (trust.publicHost && host === trust.publicHost) return true;
	return isLoopbackHost(host);
}

function trustedOrigin(origin, trust) {
	if (trust.publicOrigin && origin === trust.publicOrigin) return true;
	const parsed = parseOrigin(origin);
	if (!parsed) return false;
	return isLoopbackHost(new URL(parsed).host);
}

function parseOrigin(value) {
	if (!value) return "";
	try {
		return new URL(value).origin;
	} catch {
		return "";
	}
}

function isLoopbackHost(host) {
	const withoutPort = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
	return withoutPort === "localhost" || withoutPort === "127.0.0.1" || withoutPort === "::1";
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const bind = process.env.AO_WEB_BIND || "127.0.0.1";
	const port = Number(process.env.AO_WEB_PORT || "5173");
	const publicUrl = process.env.AO_WEB_PUBLIC_URL || "";
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`AO_WEB_PORT must be a TCP port, got ${process.env.AO_WEB_PORT}`);
	}

	const server = createAoWebServer();
	server.listen(port, bind, () => {
		const suffix = publicUrl ? ` (${publicUrl})` : "";
		console.log(`ao web server listening on http://${bind}:${port}${suffix}`);
	});
}
