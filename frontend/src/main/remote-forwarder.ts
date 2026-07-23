import http from "node:http";
import type net from "node:net";
import { BlockList, isIP } from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import type { RemoteServerConfigInput } from "./remote-server-config";

export type RemoteForwarder = {
	port: number;
	resolvePreviewURL(ownerId: string, sessionId: string, rawURL: string): string;
	releasePreview(ownerId: string): void;
	originalPreviewURL(localURL: string): string;
	close(): Promise<void>;
};

export class RemoteForwarderStartError extends Error {
	readonly code = "remote_forwarder_bind_failed" as const;

	constructor() {
		super("remote_forwarder_bind_failed");
		this.name = "RemoteForwarderStartError";
	}
}

const unavailableCode = "REMOTE_DAEMON_UNAVAILABLE";
const unavailableBody = JSON.stringify({ error: "unavailable", code: unavailableCode, message: unavailableCode });
const connectTimeoutMs = 5_000;
const lanConnectionCookie = "ao_conn";
const previewHostSuffix = ".ao-preview.localhost";
const previewUpstreamAuthorizationHeader = "x-ao-preview-upstream-authorization";
const previewTokenBytes = 16;
const previewSourceAliasLimit = 64;
const previewLoopbackIPs = new BlockList();
previewLoopbackIPs.addSubnet("127.0.0.0", 8, "ipv4");
previewLoopbackIPs.addAddress("::1", "ipv6");
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

type PreviewMapping = {
	token: string;
	ownerId: string;
	sessionId: string;
	kind: "http" | "file";
	targetHeader: string;
	sourceOrigin?: string;
	sourceOriginsByPath: Map<string, string>;
	fileURL?: string;
};

type PreviewTarget = Omit<PreviewMapping, "token" | "ownerId" | "sessionId" | "sourceOriginsByPath"> & {
	key: string;
	pathname: string;
	search: string;
	hash: string;
};

function unbracketedHostname(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function normalizedLoopbackOrigin(url: URL): string | undefined {
	if (url.username || url.password || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined;
	if (url.port === "0") return undefined;
	const hostname = unbracketedHostname(url.hostname);
	if (hostname === "localhost") return url.origin;
	const family = isIP(hostname);
	if (!family) return undefined;
	if (hostname === "0.0.0.0") {
		url.hostname = "127.0.0.1";
		return url.origin;
	}
	if (hostname === "::") {
		url.hostname = "[::1]";
		return url.origin;
	}
	if (!previewLoopbackIPs.check(hostname, family === 4 ? "ipv4" : "ipv6")) return undefined;
	return url.origin;
}

function previewTarget(rawURL: string): PreviewTarget | undefined {
	let source: URL;
	try {
		source = new URL(rawURL);
	} catch {
		return undefined;
	}
	if (source.protocol === "http:" || source.protocol === "https:") {
		const target = new URL(source);
		const targetHeader = normalizedLoopbackOrigin(target);
		if (!targetHeader) return undefined;
		return {
			kind: "http",
			key: targetHeader,
			targetHeader,
			sourceOrigin: source.origin,
			pathname: source.pathname,
			search: source.search,
			hash: source.hash,
		};
	}
	if (
		source.protocol !== "file:" ||
		source.hostname !== "" ||
		source.username !== "" ||
		source.password !== "" ||
		!source.pathname.startsWith("/")
	) {
		return undefined;
	}
	const fileTarget = new URL(source);
	fileTarget.search = "";
	fileTarget.hash = "";
	const basename = fileTarget.pathname.slice(fileTarget.pathname.lastIndexOf("/") + 1);
	if (!basename) return undefined;
	return {
		kind: "file",
		key: fileTarget.toString(),
		targetHeader: fileTarget.toString(),
		fileURL: fileTarget.toString(),
		pathname: `/${basename}`,
		search: source.search,
		hash: source.hash,
	};
}

function cookieName(value: string): string {
	const separator = value.indexOf("=");
	return value
		.slice(0, separator === -1 ? value.length : separator)
		.trim()
		.toLowerCase();
}

function requestCookieHeader(value: string | string[]): string | undefined {
	const cookies = (Array.isArray(value) ? value.join(";") : value)
		.split(";")
		.map((cookie) => cookie.trim())
		.filter((cookie) => cookie && cookieName(cookie) !== lanConnectionCookie);
	return cookies.length ? cookies.join("; ") : undefined;
}

function responseSetCookieHeader(value: string | string[]): string | string[] | undefined {
	const cookies = (Array.isArray(value) ? value : [value]).filter(
		(cookie) => cookieName(cookie) !== lanConnectionCookie,
	);
	if (!cookies.length) return undefined;
	return Array.isArray(value) ? cookies : cookies[0];
}

function previewSetCookieHeader(value: string | string[]): string | string[] | undefined {
	const filtered = responseSetCookieHeader(value);
	if (filtered === undefined) return undefined;
	const withoutDomain = (cookie: string) =>
		cookie
			.split(";")
			.filter((part, index) => index === 0 || !/^\s*domain\s*=/i.test(part))
			.join(";");
	return Array.isArray(filtered) ? filtered.map(withoutDomain) : withoutDomain(filtered);
}

type UpstreamHeaderOptions = {
	preserveUpgrade?: boolean;
	preview?: PreviewMapping;
};

function upstreamHeaders(
	headers: http.IncomingHttpHeaders,
	config: RemoteServerConfigInput,
	options: UpstreamHeaderOptions = {},
): http.OutgoingHttpHeaders {
	const previewAuthorization = options.preview ? headers.authorization : undefined;
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
		if (lower.startsWith("x-ao-preview-") || (options.preview && lower === "origin")) continue;
		if (lower === "cookie") {
			const cookie = requestCookieHeader(value);
			if (cookie) forwarded[lower] = cookie;
			continue;
		}
		forwarded[lower] = value;
	}
	if (options.preserveUpgrade && headers.upgrade) {
		forwarded.connection = "Upgrade";
		forwarded.upgrade = headers.upgrade;
	}
	forwarded.host = `${config.host}:${config.port}`;
	forwarded.authorization = `Bearer ${config.password}`;
	if (options.preview) {
		forwarded["x-ao-preview-target"] = options.preview.targetHeader;
		if (previewAuthorization) forwarded[previewUpstreamAuthorizationHeader] = previewAuthorization;
	}
	return forwarded;
}

type ResponseHeaderOptions = {
	preview?: boolean;
	location?: string;
};

function responseHeaders(
	headers: http.IncomingHttpHeaders,
	options: ResponseHeaderOptions = {},
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
		if (lower.startsWith("x-ao-preview-")) continue;
		if (lower === "set-cookie") {
			const setCookie = options.preview ? previewSetCookieHeader(value) : responseSetCookieHeader(value);
			if (setCookie) forwarded[lower] = setCookie;
			continue;
		}
		if (options.preview && lower === "location" && options.location !== undefined) {
			forwarded[lower] = options.location;
			continue;
		}
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

function rawResponseHead(response: http.IncomingMessage, options: ResponseHeaderOptions = {}): string {
	const status = `HTTP/${response.httpVersion} ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}`;
	const headers: string[] = [];
	for (let i = 0; i < response.rawHeaders.length; i += 2) {
		const name = response.rawHeaders[i];
		const lower = name.toLowerCase();
		const value = response.rawHeaders[i + 1];
		if (lower.startsWith("x-ao-preview-")) continue;
		if (lower === "set-cookie") {
			const setCookie = options.preview ? previewSetCookieHeader(value) : responseSetCookieHeader(value);
			if (typeof setCookie === "string") headers.push(`${name}: ${setCookie}`);
			continue;
		}
		if (options.preview && lower === "location" && options.location !== undefined) {
			headers.push(`${name}: ${options.location}`);
			continue;
		}
		headers.push(`${name}: ${value}`);
	}
	return `${status}\r\n${headers.join("\r\n")}\r\n\r\n`;
}

export async function startRemoteForwarder(config: RemoteServerConfigInput): Promise<RemoteForwarder> {
	const sockets = new Set<net.Socket>();
	const outboundRequests = new Set<http.ClientRequest>();
	const previewsByToken = new Map<string, PreviewMapping>();
	const previewsByOwner = new Map<string, Map<string, PreviewMapping>>();
	let closed = false;
	let forwarderPort = 0;
	const clearPreviews = () => {
		previewsByToken.clear();
		previewsByOwner.clear();
	};
	const releasePreview = (ownerId: string) => {
		const owned = previewsByOwner.get(ownerId);
		if (!owned) return;
		for (const mapping of owned.values()) previewsByToken.delete(mapping.token);
		previewsByOwner.delete(ownerId);
	};
	const rememberPreviewSourceOrigin = (mapping: PreviewMapping, local: URL, sourceOrigin: string) => {
		const key = `${local.pathname}${local.search}`;
		mapping.sourceOrigin = sourceOrigin;
		mapping.sourceOriginsByPath.delete(key);
		mapping.sourceOriginsByPath.set(key, sourceOrigin);
		if (mapping.sourceOriginsByPath.size > previewSourceAliasLimit) {
			const oldest = mapping.sourceOriginsByPath.keys().next().value;
			if (oldest !== undefined) mapping.sourceOriginsByPath.delete(oldest);
		}
	};
	const previewSourceOrigin = (mapping: PreviewMapping, local: URL): string | undefined => {
		const sourceOrigin = mapping.sourceOriginsByPath.get(`${local.pathname}${local.search}`);
		if (!sourceOrigin) return mapping.sourceOrigin;
		rememberPreviewSourceOrigin(mapping, local, sourceOrigin);
		return sourceOrigin;
	};
	const localPreviewURL = (
		mapping: PreviewMapping,
		pathname: string,
		search: string,
		hash: string,
		sourceOrigin?: string,
	) => {
		const local = new URL(`http://${mapping.token}${previewHostSuffix}:${forwarderPort}`);
		local.pathname = pathname;
		local.search = search;
		local.hash = hash;
		const localURL = local.toString();
		if (sourceOrigin) rememberPreviewSourceOrigin(mapping, local, sourceOrigin);
		return localURL;
	};
	const registerPreview = (ownerId: string, sessionId: string, target: PreviewTarget): PreviewMapping => {
		let owned = previewsByOwner.get(ownerId);
		if (!owned) {
			owned = new Map();
			previewsByOwner.set(ownerId, owned);
		}
		const key = `${sessionId}\0${target.kind}\0${target.key}`;
		const existing = owned.get(key);
		if (existing) return existing;
		let token: string;
		do {
			token = randomBytes(previewTokenBytes).toString("hex");
		} while (previewsByToken.has(token));
		const mapping: PreviewMapping = {
			token,
			ownerId,
			sessionId,
			kind: target.kind,
			targetHeader: target.targetHeader,
			sourceOrigin: target.sourceOrigin,
			sourceOriginsByPath: new Map(),
			fileURL: target.fileURL,
		};
		owned.set(key, mapping);
		previewsByToken.set(token, mapping);
		return mapping;
	};
	const resolvePreviewURL = (ownerId: string, sessionId: string, rawURL: string): string => {
		if (closed) return rawURL;
		const target = previewTarget(rawURL);
		if (!target) return rawURL;
		return localPreviewURL(
			registerPreview(ownerId, sessionId, target),
			target.pathname,
			target.search,
			target.hash,
			target.sourceOrigin,
		);
	};
	const originalPreviewURL = (localURL: string): string => {
		let local: URL;
		try {
			local = new URL(localURL);
		} catch {
			return localURL;
		}
		if (
			local.protocol !== "http:" ||
			local.port !== String(forwarderPort) ||
			!local.hostname.endsWith(previewHostSuffix)
		) {
			return localURL;
		}
		const token = local.hostname.slice(0, -previewHostSuffix.length);
		const mapping = previewsByToken.get(token);
		if (!mapping) return localURL;
		if (mapping.kind === "http") {
			const original = new URL(previewSourceOrigin(mapping, local)!);
			original.pathname = local.pathname;
			original.search = local.search;
			original.hash = local.hash;
			return original.toString();
		}
		const original = new URL(local.pathname.slice(1), new URL(".", mapping.fileURL!));
		original.search = local.search;
		original.hash = local.hash;
		return original.toString();
	};
	const previewMappingForHost = (
		host: string | undefined,
	): { previewNamespace: false } | { previewNamespace: true; mapping?: PreviewMapping } => {
		if (!host) return { previewNamespace: false };
		const normalized = host.toLowerCase();
		if (!normalized.includes("ao-preview.localhost")) return { previewNamespace: false };
		const match = /^([0-9a-f]{32})\.ao-preview\.localhost:([0-9]+)$/.exec(normalized);
		if (!match || match[2] !== String(forwarderPort)) return { previewNamespace: true };
		return { previewNamespace: true, mapping: previewsByToken.get(match[1]) };
	};
	const previewUpstreamPath = (mapping: PreviewMapping, requestURL: string | undefined): string => {
		const suffix = requestURL?.startsWith("/") ? requestURL : `/${requestURL ?? ""}`;
		return `/_ao/preview/${encodeURIComponent(mapping.sessionId)}${suffix}`;
	};
	const previewResponseOptions = (
		mapping: PreviewMapping,
		requestURL: string | undefined,
		upstreamResponse: http.IncomingMessage,
	): ResponseHeaderOptions => {
		const localRequest = new URL(
			requestURL ?? "/",
			`http://${mapping.token}${previewHostSuffix}:${forwarderPort}`,
		);
		const sourceOrigin = mapping.kind === "http" ? previewSourceOrigin(mapping, localRequest) : undefined;
		const location = upstreamResponse.headers.location;
		if (!location) return { preview: true };
		let targetLocation: URL | undefined;
		if (mapping.kind === "http") {
			try {
				targetLocation = new URL(location, new URL(requestURL ?? "/", sourceOrigin ?? mapping.targetHeader));
			} catch {
				targetLocation = undefined;
			}
		}
		const destination = targetLocation ? previewTarget(targetLocation.toString()) : undefined;
		const redirectTargetValue = upstreamResponse.headers["x-ao-preview-redirect-target"];
		const redirectTarget = Array.isArray(redirectTargetValue) ? redirectTargetValue[0] : redirectTargetValue;
		if (
			redirectTarget &&
			(upstreamResponse.statusCode ?? 0) >= 300 &&
			(upstreamResponse.statusCode ?? 0) < 400 &&
			previewsByToken.get(mapping.token) === mapping
		) {
			const indicated = previewTarget(redirectTarget);
			if (
				indicated?.kind === "http" &&
				indicated.pathname === "/" &&
				indicated.search === "" &&
				indicated.hash === "" &&
				destination?.kind === "http" &&
				destination.targetHeader === indicated.targetHeader
			) {
				return {
					preview: true,
					location: localPreviewURL(
						registerPreview(mapping.ownerId, mapping.sessionId, destination),
						destination.pathname,
						destination.search,
						destination.hash,
						destination.sourceOrigin,
					),
				};
			}
		}
		if (mapping.kind === "file") {
			try {
				const absolute = new URL(location);
				if (absolute.protocol) return { preview: true, location };
			} catch {
				return { preview: true, location: new URL(location, localRequest).toString() };
			}
			return { preview: true, location };
		}
		if (destination?.kind !== "http" || destination.targetHeader !== mapping.targetHeader) {
			return { preview: true, location };
		}
		return {
			preview: true,
			location: localPreviewURL(
				mapping,
				destination.pathname,
				destination.search,
				destination.hash,
				destination.sourceOrigin,
			),
		};
	};
	const destroyOutboundRequest = (request: http.ClientRequest, message: string) => {
		outboundRequests.delete(request);
		const error = new Error(message);
		request.destroy(error);
		request.socket?.destroy(error);
	};
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
				destroyOutboundRequest(request, "Remote AO daemon connection timed out.");
			}, connectTimeoutMs);
			socket.once("connect", clearConnectTimer);
			socket.once("error", clearConnectTimer);
			socket.once("close", clearConnectTimer);
		});
		request.once("response", (response) => {
			response.once("close", () => outboundRequests.delete(request));
		});
		request.once("upgrade", () => outboundRequests.delete(request));
		request.once("error", () => {
			clearConnectTimer();
			outboundRequests.delete(request);
		});
		request.once("close", () => {
			clearConnectTimer();
		});
		return request;
	};
	const server = http.createServer((request, response) => {
		const previewRoute = previewMappingForHost(request.headers.host);
		if (previewRoute.previewNamespace && !previewRoute.mapping) {
			response.writeHead(404, { "content-length": "0" });
			response.end();
			return;
		}
		const preview = previewRoute.previewNamespace ? previewRoute.mapping : undefined;
		const upstream = trackOutboundRequest(
			http.request({
				hostname: config.host,
				port: config.port,
				method: request.method,
				path: preview ? previewUpstreamPath(preview, request.url) : request.url,
				headers: upstreamHeaders(request.headers, config, { preview }),
			}),
		);
		const cancelUpstream = () => {
			destroyOutboundRequest(upstream, "Downstream request closed.");
		};
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
			const headerOptions = preview ? previewResponseOptions(preview, request.url, upstreamResponse) : undefined;
			response.writeHead(
				upstreamResponse.statusCode ?? 502,
				responseHeaders(upstreamResponse.headers, headerOptions),
			);
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
		const previewRoute = previewMappingForHost(request.headers.host);
		if (previewRoute.previewNamespace && !previewRoute.mapping) {
			clientSocket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
			return;
		}
		const preview = previewRoute.previewNamespace ? previewRoute.mapping : undefined;
		const upstream = trackOutboundRequest(
			http.request({
				hostname: config.host,
				port: config.port,
				method: request.method,
				path: preview ? previewUpstreamPath(preview, request.url) : request.url,
				headers: upstreamHeaders(request.headers, config, { preserveUpgrade: true, preview }),
			}),
		);
		const cancelPendingUpgrade = () => {
			destroyOutboundRequest(upstream, "Downstream WebSocket closed before upgrade.");
		};
		clientSocket.once("close", cancelPendingUpgrade);
		clientSocket.once("end", cancelPendingUpgrade);
		clientSocket.once("error", cancelPendingUpgrade);
		upstream.once("upgrade", (response, upstreamSocket, upstreamHead) => {
			sockets.add(upstreamSocket);
			upstreamSocket.once("close", () => sockets.delete(upstreamSocket));
			clientSocket.once("end", () => upstreamSocket.end());
			upstreamSocket.once("end", () => clientSocket.end());
			clientSocket.once("close", () => upstreamSocket.destroy());
			upstreamSocket.once("close", () => clientSocket.destroy());
			clientSocket.once("error", () => upstreamSocket.destroy());
			upstreamSocket.once("error", () => clientSocket.destroy());
			const headerOptions = preview ? previewResponseOptions(preview, request.url, response) : undefined;
			clientSocket.write(rawResponseHead(response, headerOptions));
			if (upstreamHead.length) clientSocket.write(upstreamHead);
			if (clientHead.length) upstreamSocket.write(clientHead);
			clientSocket.pipe(upstreamSocket).pipe(clientSocket);
		});
		upstream.once("response", (response) => {
			response.once("aborted", () => clientSocket.destroy());
			response.once("error", () => clientSocket.destroy());
			const headerOptions = preview ? previewResponseOptions(preview, request.url, response) : undefined;
			clientSocket.write(rawResponseHead(response, headerOptions));
			response.pipe(clientSocket);
		});
		upstream.once("error", () => {
			if (clientSocket.destroyed) return;
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
		throw new RemoteForwarderStartError();
	}
	forwarderPort = address.port;

	return {
		port: address.port,
		resolvePreviewURL,
		releasePreview,
		originalPreviewURL,
		close: async () => {
			closed = true;
			clearPreviews();
			for (const request of outboundRequests) destroyOutboundRequest(request, "Remote forwarder closed.");
			outboundRequests.clear();
			for (const socket of sockets) socket.destroy();
			if (!server.listening) return;
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}
