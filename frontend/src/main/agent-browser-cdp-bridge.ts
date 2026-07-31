import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";

const MAX_CDP_COMMAND_BYTES = 1 << 20;

export type AgentBrowserDebugger = {
	attach(protocolVersion?: string): void;
	detach(): void;
	isAttached(): boolean;
	sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
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

type AttachedTarget = {
	targetId: string;
	socket: WebSocket;
	messageListener: (...args: unknown[]) => void;
	detachListener: (...args: unknown[]) => void;
	ownedDebugger: boolean;
};

export class AgentBrowserCDPBridge {
	private readonly server: WebSocketServer;
	private readonly pathToken = randomBytes(32).toString("base64url");
	private readonly attached = new Map<string, AttachedTarget>();
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
		this.server.on("connection", (socket) => this.handleConnection(socket));
		return this.endpoint;
	}

	async close(): Promise<void> {
		for (const sessionId of [...this.attached.keys()]) this.detachTarget(sessionId);
		for (const socket of this.server.clients) socket.close(1001, "AO browser session closed");
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
		this.endpoint = "";
	}

	private handleConnection(socket: WebSocket): void {
		let chain = Promise.resolve();
		socket.on("message", (data) => {
			chain = chain.then(() => this.handleMessage(socket, data)).catch(() => undefined);
		});
		socket.on("close", () => {
			for (const [sessionId, attached] of this.attached) {
				if (attached.socket === socket) this.detachTarget(sessionId);
			}
		});
	}

	private async handleMessage(socket: WebSocket, raw: RawData): Promise<void> {
		let request: CDPRequest;
		try {
			request = JSON.parse(raw.toString()) as CDPRequest;
		} catch {
			return;
		}
		if (!Number.isInteger(request.id) || typeof request.method !== "string") return;
		try {
			const result = request.sessionId
				? await this.forwardTargetCommand(request)
				: await this.handleBrowserCommand(socket, request);
			this.send(socket, { id: request.id, result: result ?? {}, ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
		} catch (error) {
			this.send(socket, {
				id: request.id,
				error: {
					code: -32000,
					message: error instanceof Error ? error.message : "CDP command failed",
				},
				...(request.sessionId ? { sessionId: request.sessionId } : {}),
			});
		}
	}

	private async handleBrowserCommand(socket: WebSocket, request: CDPRequest): Promise<unknown> {
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
			case "Target.setDiscoverTargets":
			case "Target.setAutoAttach":
				return {};
			case "Target.getTargets":
				return { targetInfos: this.targets.listTargets().map((target) => this.targetInfo(target)) };
			case "Target.getTargetInfo": {
				const target = this.requireTarget(optionalString(params.targetId) ?? this.targets.listTargets()[0]?.id);
				return { targetInfo: this.targetInfo(target) };
			}
			case "Target.attachToTarget": {
				const target = this.requireTarget(optionalString(params.targetId));
				const sessionId = `ao-${randomUUID()}`;
				const ownedDebugger = !target.debugger.isAttached();
				if (ownedDebugger) target.debugger.attach("1.3");
				const messageListener = (...args: unknown[]) => {
					const method = typeof args[1] === "string" ? args[1] : "";
					if (!method) return;
					this.send(socket, {
						method,
						params: isRecord(args[2]) ? args[2] : {},
						sessionId,
					});
				};
				const detachListener = () => {
					this.send(socket, {
						method: "Inspector.detached",
						params: { reason: "AO released the page debugger" },
						sessionId,
					});
					this.detachTarget(sessionId, false);
					socket.close(1012, "AO page debugger was released");
				};
				target.debugger.on("message", messageListener);
				target.debugger.on("detach", detachListener);
				this.attached.set(sessionId, {
					targetId: target.id,
					socket,
					messageListener,
					detachListener,
					ownedDebugger,
				});
				return { sessionId };
			}
			case "Target.detachFromTarget": {
				const sessionId = optionalString(params.sessionId);
				if (sessionId) this.detachTarget(sessionId);
				return {};
			}
			case "Target.createTarget": {
				const url = safeNavigationURL(optionalString(params.url) ?? "about:blank");
				const target = await this.targets.createTarget(url);
				this.send(socket, { method: "Target.targetCreated", params: { targetInfo: this.targetInfo(target) } });
				return { targetId: target.id };
			}
			case "Target.activateTarget": {
				const target = this.requireTarget(optionalString(params.targetId));
				await this.targets.activateTarget(target.id);
				return {};
			}
			case "Target.closeTarget": {
				const target = this.requireTarget(optionalString(params.targetId));
				for (const [sessionId, attached] of this.attached) {
					if (attached.targetId === target.id) this.detachTarget(sessionId, false);
				}
				await this.targets.closeTarget(target.id);
				this.send(socket, { method: "Target.targetDestroyed", params: { targetId: target.id } });
				return { success: true };
			}
			case "Browser.close":
				throw new Error("Browser.close is not permitted for AO-owned previews");
			default:
				throw new Error(`Unsupported browser-level CDP method: ${request.method}`);
		}
	}

	private async forwardTargetCommand(request: CDPRequest): Promise<unknown> {
		const attached = this.attached.get(request.sessionId!);
		if (!attached) throw new Error("Unknown or expired target session");
		const target = this.requireTarget(attached.targetId);
		assertSafeTargetMethod(request.method, request.params);
		return target.debugger.sendCommand(request.method, request.params);
	}

	private requireTarget(targetId: string | undefined): AgentBrowserTarget {
		if (!targetId) throw new Error("targetId is required");
		const target = this.targets.listTargets().find((candidate) => candidate.id === targetId);
		if (!target) throw new Error("Target is outside this AO worker");
		return target;
	}

	private targetInfo(target: AgentBrowserTarget): Record<string, unknown> {
		return {
			targetId: target.id,
			type: "page",
			title: target.title,
			url: target.url || "about:blank",
			attached: [...this.attached.values()].some((attached) => attached.targetId === target.id),
			canAccessOpener: false,
		};
	}

	private detachTarget(sessionId: string, detachDebugger = true): void {
		const attached = this.attached.get(sessionId);
		if (!attached) return;
		this.attached.delete(sessionId);
		const target = this.targets.listTargets().find((candidate) => candidate.id === attached.targetId);
		target?.debugger.off?.("message", attached.messageListener);
		target?.debugger.off?.("detach", attached.detachListener);
		if (detachDebugger && attached.ownedDebugger && target?.debugger.isAttached()) {
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
