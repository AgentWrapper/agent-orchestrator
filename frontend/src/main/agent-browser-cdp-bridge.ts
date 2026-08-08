import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";

const MAX_CDP_COMMAND_BYTES = 1 << 20;

export type AgentBrowserDebugger = {
	attach(protocolVersion?: string): void;
	detach(): void;
	isAttached(): boolean;
	sendCommand(method: string, commandParams?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
	on(event: "message" | "detach", listener: (...args: unknown[]) => void): unknown;
	off?(event: "message" | "detach", listener: (...args: unknown[]) => void): unknown;
};

export type AgentBrowserTarget = {
	id: string;
	url: string;
	title: string;
	debugger: AgentBrowserDebugger;
};

export type AgentBrowserTargetProvider = {
	listTargets(): AgentBrowserTarget[];
	createTarget(url: string): Promise<AgentBrowserTarget>;
	activateTarget(targetId: string): Promise<void> | void;
	closeTarget(targetId: string): Promise<void> | void;
};

type CDPRequest = {
	id: number;
	method: string;
	params?: Record<string, unknown>;
	sessionId?: string;
};

type ConnectionContext = {
	socket: WebSocket;
	targetId?: string;
	trustedDevtools: boolean;
	devtoolsClientKey?: string;
};

type AttachedTarget = {
	targetId: string;
	connection: ConnectionContext;
	protocolSessionId?: string;
	chromiumChildSessionIds: Set<string>;
};

/**
 * One physical Electron debugger attachment can serve multiple logical CDP
 * clients. The agent-browser daemon and the official Chromium DevTools
 * frontend both connect here; detaching either client must not detach the
 * underlying page debugger while the other client is still active.
 */
type PhysicalTargetAttachment = {
	targetId: string;
	debugger: AgentBrowserDebugger;
	clients: Map<string, AttachedTarget>;
	messageListener: (...args: unknown[]) => void;
	detachListener: (...args: unknown[]) => void;
	ownedDebugger: boolean;
};

type DevtoolsCapability = {
	targetId: string;
};

export class AgentBrowserCDPBridge {
	private readonly server: WebSocketServer;
	private readonly pathToken = randomBytes(32).toString("base64url");
	private readonly attached = new Map<string, AttachedTarget>();
	private readonly physical = new Map<string, PhysicalTargetAttachment>();
	private readonly devtoolsCapabilities = new Map<string, DevtoolsCapability>();
	private endpoint = "";

	constructor(private readonly targets: AgentBrowserTargetProvider) {
		this.server = new WebSocketServer({
			host: "127.0.0.1",
			port: 0,
			path: `/${this.pathToken}`,
			maxPayload: MAX_CDP_COMMAND_BYTES,
		});
	}

	async start(): Promise<string> {
		if (this.endpoint) return this.endpoint;
		await new Promise<void>((resolve, reject) => {
			this.server.once("listening", resolve);
			this.server.once("error", reject);
		});
		const address = this.server.address();
		if (!address || typeof address === "string") {
			throw new Error("Unable to determine agent-browser CDP bridge address");
		}
		this.endpoint = `ws://127.0.0.1:${address.port}/${this.pathToken}`;
		this.server.on("connection", (socket, request) => {
			let requestURL: URL;
			try {
				requestURL = new URL(request.url ?? "/", "ws://127.0.0.1");
			} catch {
				socket.close(1008, "Invalid AO browser CDP endpoint");
				return;
			}
			const devtoolsToken = optionalString(requestURL.searchParams.get("devtools"));
			const devtoolsCapability = devtoolsToken ? this.devtoolsCapabilities.get(devtoolsToken) : undefined;
			if (devtoolsToken && !devtoolsCapability) {
				socket.close(1008, "Invalid AO browser DevTools capability");
				return;
			}
			this.handleConnection(socket, {
				socket,
				targetId: devtoolsCapability?.targetId,
				trustedDevtools: Boolean(devtoolsCapability),
			});
		});
		return this.endpoint;
	}

	/** Returns a private, target-pinned endpoint for the Chromium DevTools UI. */
	endpointForTarget(targetId: string): string {
		if (!this.endpoint) throw new Error("AO browser CDP bridge is not started");
		if (!this.targets.listTargets().some((target) => target.id === targetId)) {
			throw new Error("Target is outside this AO worker");
		}
		// The target binding and elevated protocol role live in this in-memory map.
		// Never derive either privilege from query-string values: the base endpoint
		// is intentionally passed to the restricted agent-browser process.
		const token = randomBytes(32).toString("base64url");
		this.devtoolsCapabilities.set(token, { targetId });
		const query = new URLSearchParams({ devtools: token });
		return `${this.endpoint}?${query.toString()}`;
	}

	async close(): Promise<void> {
		for (const sessionId of [...this.attached.keys()]) this.detachTarget(sessionId);
		for (const socket of this.server.clients) socket.close(1001, "AO browser session closed");
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
		this.physical.clear();
		this.devtoolsCapabilities.clear();
		this.endpoint = "";
	}

	private handleConnection(socket: WebSocket, connection: ConnectionContext): void {
		socket.on("message", (data) => {
			// CDP correlates responses by request id and permits them to complete out
			// of order. Serializing the whole socket makes DevTools startup painfully
			// slow because its independent Page/DOM/Runtime/Network requests wait on
			// one another for no protocol reason.
			void this.handleMessage(connection, data).catch(() => undefined);
		});
		socket.on("close", () => {
			for (const [sessionId, attached] of this.attached) {
				if (attached.connection.socket === socket) this.detachTarget(sessionId);
			}
			this.releaseDirectDevtoolsClient(connection);
		});
	}

	private async handleMessage(connection: ConnectionContext, raw: RawData): Promise<void> {
		let request: CDPRequest;
		try {
			request = JSON.parse(raw.toString()) as CDPRequest;
		} catch {
			return;
		}
		if (!Number.isInteger(request.id) || typeof request.method !== "string") return;
		try {
			// The Chromium inspector URL points at a page endpoint. Keep that
			// connection page-shaped and forward every domain (including Target.*)
			// to Chromium. Synthesizing a browser/root attachment here creates an
			// extra target in DevTools and leaves the real page panels half-initialized.
			const result =
				connection.trustedDevtools && connection.targetId
					? await this.forwardDirectDevtoolsCommand(connection, request)
					: request.sessionId
						? await this.forwardTargetCommand(connection, request)
						: await this.handleBrowserCommand(connection, request);
			this.send(connection.socket, {
				id: request.id,
				result: result ?? {},
				...(request.sessionId ? { sessionId: request.sessionId } : {}),
			});
		} catch (error) {
			this.send(connection.socket, {
				id: request.id,
				error: {
					code: -32000,
					message: error instanceof Error ? error.message : "CDP command failed",
				},
				...(request.sessionId ? { sessionId: request.sessionId } : {}),
			});
		}
	}

	private async handleBrowserCommand(connection: ConnectionContext, request: CDPRequest): Promise<unknown> {
		const params = request.params ?? {};
		switch (request.method) {
			case "Browser.getVersion":
				return {
					protocolVersion: "1.3",
					product: `Chrome/${process.versions.chrome ?? "0"}`,
					revision: "",
					userAgent: "AO agent-browser bridge",
					jsVersion: process.versions.v8 ?? "",
				};
			case "Target.setDiscoverTargets": {
				if (connection.trustedDevtools && connection.targetId && params.discover === true) {
					const target = this.requireTarget(connection.targetId, connection);
					this.send(connection.socket, {
						method: "Target.targetCreated",
						params: { targetInfo: this.targetInfo(target) },
					});
				}
				return {};
			}
			case "Target.setAutoAttach": {
				if (connection.trustedDevtools && connection.targetId && params.autoAttach === true) {
					const target = this.requireTarget(connection.targetId, connection);
					const sessionId = this.attachTarget(connection, target);
					this.send(connection.socket, {
						method: "Target.attachedToTarget",
						params: {
							sessionId,
							targetInfo: this.targetInfo(target),
							waitingForDebugger: false,
						},
					});
				}
				return {};
			}
			case "Target.getTargets":
				return { targetInfos: this.listTargets(connection).map((target) => this.targetInfo(target)) };
			case "Target.getTargetInfo": {
				const target = this.requireTarget(
					optionalString(params.targetId) ?? this.listTargets(connection)[0]?.id,
					connection,
				);
				return { targetInfo: this.targetInfo(target) };
			}
			case "Target.attachToTarget": {
				const target = this.requireTarget(optionalString(params.targetId), connection);
				const sessionId = this.attachTarget(connection, target);
				this.send(connection.socket, {
					method: "Target.attachedToTarget",
					params: {
						sessionId,
						targetInfo: this.targetInfo(target),
						waitingForDebugger: false,
					},
				});
				return { sessionId };
			}
			case "Target.detachFromTarget": {
				const sessionId = optionalString(params.sessionId);
				if (sessionId) {
					const attached = this.attached.get(sessionId);
					if (attached && attached.connection.socket !== connection.socket) {
						throw new Error("Target session belongs to another CDP client");
					}
					this.detachTarget(sessionId);
				}
				return {};
			}
			case "Target.sendMessageToTarget": {
				const sessionId = optionalString(params.sessionId);
				const encoded = optionalString(params.message);
				if (!sessionId || !encoded) throw new Error("Target.sendMessageToTarget requires sessionId and message");
				let nested: CDPRequest;
				try {
					nested = JSON.parse(encoded) as CDPRequest;
				} catch {
					throw new Error("Target.sendMessageToTarget message must be valid JSON");
				}
				if (typeof nested.method !== "string") throw new Error("Target message method is required");
				return this.forwardTargetCommand(connection, { ...nested, sessionId });
			}
			case "Target.createTarget": {
				if (connection.targetId) throw new Error("Target creation is not permitted for a pinned DevTools client");
				const url = safeNavigationURL(optionalString(params.url) ?? "about:blank");
				const target = await this.targets.createTarget(url);
				this.send(connection.socket, { method: "Target.targetCreated", params: { targetInfo: this.targetInfo(target) } });
				return { targetId: target.id };
			}
			case "Target.activateTarget": {
				const target = this.requireTarget(optionalString(params.targetId), connection);
				await this.targets.activateTarget(target.id);
				return {};
			}
			case "Target.closeTarget": {
				if (connection.targetId) throw new Error("Target closing is not permitted for a pinned DevTools client");
				const target = this.requireTarget(optionalString(params.targetId), connection);
				for (const [sessionId, attached] of this.attached) {
					if (attached.targetId === target.id) this.detachTarget(sessionId, false);
				}
				await this.targets.closeTarget(target.id);
				this.send(connection.socket, { method: "Target.targetDestroyed", params: { targetId: target.id } });
				return { success: true };
			}
			case "Browser.getWindowForTarget":
				return { windowId: 1, bounds: { left: 0, top: 0, width: 1280, height: 720, windowState: "normal" } };
			case "Schema.getDomains":
				return { domains: [] };
			case "Browser.close":
				throw new Error("Browser.close is not permitted for AO-owned previews");
			default:
				throw new Error(`Unsupported browser-level CDP method: ${request.method}`);
		}
	}

	private attachTarget(connection: ConnectionContext, target: AgentBrowserTarget): string {
		const sessionId = `ao-${randomUUID()}`;
		const physical = this.ensurePhysical(target);
		const client: AttachedTarget = {
			targetId: target.id,
			connection,
			protocolSessionId: sessionId,
			chromiumChildSessionIds: new Set(),
		};
		physical.clients.set(sessionId, client);
		this.attached.set(sessionId, client);
		return sessionId;
	}

	private async forwardTargetCommand(connection: ConnectionContext, request: CDPRequest): Promise<unknown> {
		const requestedSessionId = request.sessionId!;
		let attached = this.attached.get(requestedSessionId);
		let chromiumSessionId: string | undefined;
		if (attached && attached.connection.socket !== connection.socket) {
			throw new Error("Target session belongs to another CDP client");
		}
		if (!attached) {
			attached = [...this.attached.values()].find(
				(candidate) =>
					candidate.connection.socket === connection.socket &&
					candidate.chromiumChildSessionIds.has(requestedSessionId),
			);
			chromiumSessionId = attached ? requestedSessionId : undefined;
		}
		if (!attached) throw new Error("Unknown or expired target session");
		const target = this.requireTarget(attached.targetId, attached.connection);
		if (!attached.connection.trustedDevtools) assertSafeTargetMethod(request.method, request.params);
		return chromiumSessionId
			? target.debugger.sendCommand(request.method, request.params, chromiumSessionId)
			: target.debugger.sendCommand(request.method, request.params);
	}

	/**
	 * Chromium's inspector frontend normally connects to a page WebSocket and
	 * sends Runtime/Page/Network commands without a Target sessionId. A pinned
	 * DevTools endpoint is allowed to use that page-target shape as well as the
	 * browser-target handshake used by agent-browser.
	 */
	private async forwardDirectDevtoolsCommand(
		connection: ConnectionContext,
		request: CDPRequest,
	): Promise<unknown> {
		if (request.method === "Browser.close") {
			throw new Error("Browser.close is not permitted for AO-owned previews");
		}
		const target = this.requireTarget(connection.targetId, connection);
		const physical = this.ensurePhysical(target);
		if (!connection.devtoolsClientKey) {
			const clientKey = `devtools-${randomUUID()}`;
			connection.devtoolsClientKey = clientKey;
			physical.clients.set(clientKey, { targetId: target.id, connection, chromiumChildSessionIds: new Set() });
		}
		// User-facing DevTools intentionally retains the full CDP surface. AO's
		// agent client remains on forwardTargetCommand and its safety policy.
		return request.sessionId
			? physical.debugger.sendCommand(request.method, request.params, request.sessionId)
			: physical.debugger.sendCommand(request.method, request.params);
	}

	private ensurePhysical(target: AgentBrowserTarget): PhysicalTargetAttachment {
		const existing = this.physical.get(target.id);
		if (existing) return existing;
		const ownedDebugger = !target.debugger.isAttached();
		if (ownedDebugger) target.debugger.attach("1.3");
		const physical: PhysicalTargetAttachment = {
			targetId: target.id,
			debugger: target.debugger,
			clients: new Map(),
			messageListener: () => undefined,
			detachListener: () => undefined,
			ownedDebugger,
		};
		physical.messageListener = (...args: unknown[]) => {
			const method = typeof args[1] === "string" ? args[1] : "";
			if (!method) return;
			const params = isRecord(args[2]) ? args[2] : {};
			const chromiumSessionId = optionalString(args[3]);
			for (const client of physical.clients.values()) {
				const eventSessionId = client.protocolSessionId
					? chromiumSessionId && client.chromiumChildSessionIds.has(chromiumSessionId)
						? chromiumSessionId
						: client.protocolSessionId
					: chromiumSessionId;
				this.send(client.connection.socket, {
					method,
					params,
					...(eventSessionId ? { sessionId: eventSessionId } : {}),
				});
				const childSessionId = optionalString(params.sessionId);
				if (method === "Target.attachedToTarget" && childSessionId) {
					client.chromiumChildSessionIds.add(childSessionId);
				} else if (method === "Target.detachedFromTarget" && childSessionId) {
					client.chromiumChildSessionIds.delete(childSessionId);
				}
			}
		};
		physical.detachListener = () => {
			for (const client of physical.clients.values()) {
				this.send(client.connection.socket, {
					method: "Inspector.detached",
					params: { reason: "AO page debugger was released" },
					...(client.protocolSessionId ? { sessionId: client.protocolSessionId } : {}),
				});
				if (client.protocolSessionId) this.attached.delete(client.protocolSessionId);
				client.connection.devtoolsClientKey = undefined;
				client.connection.socket.close(1012, "AO page debugger was released");
			}
			physical.clients.clear();
			this.physical.delete(target.id);
		};
		target.debugger.on("message", physical.messageListener);
		target.debugger.on("detach", physical.detachListener);
		this.physical.set(target.id, physical);
		return physical;
	}

	private releaseDirectDevtoolsClient(connection: ConnectionContext): void {
		const clientKey = connection.devtoolsClientKey;
		if (!clientKey) return;
		for (const physical of this.physical.values()) {
			const client = physical.clients.get(clientKey);
			if (!client) continue;
			physical.clients.delete(clientKey);
			this.detachPhysicalIfUnused(physical, true);
			break;
		}
		connection.devtoolsClientKey = undefined;
	}

	private listTargets(connection?: ConnectionContext): AgentBrowserTarget[] {
		const targets = this.targets.listTargets();
		if (!connection?.targetId) return targets;
		return targets.filter((target) => target.id === connection.targetId);
	}

	private requireTarget(targetId: string | undefined, connection?: ConnectionContext): AgentBrowserTarget {
		if (!targetId) throw new Error("targetId is required");
		const target = this.listTargets(connection).find((candidate) => candidate.id === targetId);
		if (!target) throw new Error("Target is outside this AO worker");
		return target;
	}

	private targetInfo(target: AgentBrowserTarget): Record<string, unknown> {
		return {
			targetId: target.id,
			type: "page",
			title: target.title,
			url: target.url || "about:blank",
			attached: this.physical.has(target.id),
			canAccessOpener: false,
		};
	}

	private detachTarget(sessionId: string, detachDebugger = true): void {
		const attached = this.attached.get(sessionId);
		if (!attached) return;
		this.attached.delete(sessionId);
		const physical = this.physical.get(attached.targetId);
		physical?.clients.delete(sessionId);
		if (physical) this.detachPhysicalIfUnused(physical, detachDebugger);
	}

	private detachPhysicalIfUnused(physical: PhysicalTargetAttachment, detachDebugger: boolean): void {
		if (physical.clients.size > 0) return;
		this.physical.delete(physical.targetId);
		const target = this.targets.listTargets().find((candidate) => candidate.id === physical.targetId);
		physical.debugger.off?.("message", physical.messageListener);
		physical.debugger.off?.("detach", physical.detachListener);
		if (detachDebugger && physical.ownedDebugger && target?.debugger.isAttached()) {
			try {
				target.debugger.detach();
			} catch {
				// Electron may already be tearing the WebContents down.
			}
		}
	}

	private send(socket: WebSocket, message: unknown): void {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
	}
}

function assertSafeTargetMethod(method: string, params: Record<string, unknown> | undefined): void {
	if (method === "Page.navigate") safeNavigationURL(optionalString(params?.url) ?? "");
	if (
		method === "Browser.close" ||
		method === "Browser.setDownloadBehavior" ||
		method === "Page.close" ||
		method === "Page.setDownloadBehavior" ||
		method === "Page.printToPDF" ||
		method === "DOM.setFileInputFiles" ||
		method.startsWith("Fetch.") ||
		method.startsWith("Storage.") ||
		method === "Network.getAllCookies" ||
		method === "Network.getCookies" ||
		method === "Network.setCookie" ||
		method === "Network.setCookies" ||
		method === "Network.clearBrowserCookies"
	) {
		throw new Error(`CDP method is not permitted by AO: ${method}`);
	}
}

function safeNavigationURL(raw: string): string {
	if (raw === "about:blank") return raw;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("Navigation requires an explicit HTTP(S) URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Navigation scheme is not permitted: ${url.protocol}`);
	}
	return url.href;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
