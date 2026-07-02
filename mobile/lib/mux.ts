import { muxUrl, type ServerConfig } from "./config";

// Mirrors AO's mux-protocol.ts (the bits we use).
export type SessionPatch = {
	id: string;
	status: string;
	activity: string | null;
	attentionLevel: string;
	lastActivityAt: string;
};

export type MuxStatus = "connecting" | "open" | "closed" | "error";

type Handlers = {
	onStatus?: (s: MuxStatus, detail?: string) => void;
	onTerminalData?: (id: string, bytes: Uint8Array) => void;
	onTerminalOpened?: (id: string) => void;
	onTerminalExited?: (id: string, code: number) => void;
	onTerminalError?: (id: string, message: string) => void;
	onSessions?: (sessions: SessionPatch[]) => void;
};

// Encode a JS string (already UTF-8 decoded by the server) back to UTF-8 bytes
// for xterm. Prefer the native TextEncoder; fall back to a manual encoder if a
// runtime ever lacks it, so the terminal never hard-crashes on a missing global.
const nativeEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

function utf8Encode(str: string): Uint8Array {
	if (nativeEncoder) return nativeEncoder.encode(str);
	const out: number[] = [];
	for (let i = 0; i < str.length; i++) {
		let c = str.charCodeAt(i);
		if (c < 0x80) {
			out.push(c);
		} else if (c < 0x800) {
			out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
		} else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
			const c2 = str.charCodeAt(++i);
			c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
			out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
		} else {
			out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
		}
	}
	return new Uint8Array(out);
}

/**
 * Thin client over AO's mux WebSocket. One socket multiplexes session-status
 * snapshots and per-session terminal I/O. Auto-reconnects with backoff.
 */
export class MuxClient {
	private ws: WebSocket | null = null;
	private cfg: ServerConfig;
	private handlers: Handlers;
	private closedByUser = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private backoff = 1000;
	// Terminals we want open, so we can re-open them after a reconnect. Maps the
	// session id -> its projectId so the re-open carries projectId too (the server
	// may need it to locate the right session across projects).
	private openTerminals = new Map<string, string | undefined>();
	private subscribed = false;

	constructor(cfg: ServerConfig, handlers: Handlers) {
		this.cfg = cfg;
		this.handlers = handlers;
	}

	connect() {
		this.closedByUser = false;
		this.open();
	}

	private open() {
		this.handlers.onStatus?.("connecting");
		let ws: WebSocket;
		try {
			ws = new WebSocket(muxUrl(this.cfg));
		} catch (e) {
			this.handlers.onStatus?.("error", String(e));
			this.scheduleReconnect();
			return;
		}
		this.ws = ws;

		ws.onopen = () => {
			this.backoff = 1000;
			this.handlers.onStatus?.("open");
			if (this.subscribed) this.send({ ch: "subscribe", topics: ["sessions", "notifications"] });
			// Re-open any terminals that were active before a reconnect (with projectId).
			for (const [id, projectId] of this.openTerminals) {
				this.send({ ch: "terminal", id, type: "open", projectId });
			}
			this.pingTimer = setInterval(() => {
				this.send({ ch: "system", type: "ping" });
			}, 20000);
		};

		ws.onmessage = (ev) => {
			let msg: unknown;
			try {
				msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
			} catch {
				return;
			}
			this.handle(msg);
		};

		ws.onerror = () => {
			this.handlers.onStatus?.("error");
		};

		ws.onclose = () => {
			this.clearPing();
			if (this.closedByUser) {
				this.handlers.onStatus?.("closed");
				return;
			}
			this.handlers.onStatus?.("closed");
			this.scheduleReconnect();
		};
	}

	private handle(raw: unknown) {
		if (!raw || typeof raw !== "object") return;
		const msg = raw as {
			ch?: string;
			type?: string;
			sessions?: SessionPatch[];
			id?: string;
			data?: string;
			code?: number;
			message?: string;
		};
		if (msg.ch === "sessions" && msg.type === "snapshot") {
			this.handlers.onSessions?.(msg.sessions ?? []);
		} else if (msg.ch === "terminal") {
			const id = msg.id ?? "";
			switch (msg.type) {
				case "data":
					this.handlers.onTerminalData?.(id, utf8Encode(String(msg.data ?? "")));
					break;
				case "opened":
					this.handlers.onTerminalOpened?.(id);
					break;
				case "exited":
					this.handlers.onTerminalExited?.(id, msg.code ?? 0);
					break;
				case "error":
					this.handlers.onTerminalError?.(id, msg.message ?? "terminal error");
					break;
			}
		}
	}

	private scheduleReconnect() {
		if (this.closedByUser) return;
		this.clearReconnect();
		this.reconnectTimer = setTimeout(() => this.open(), this.backoff);
		this.backoff = Math.min(this.backoff * 2, 15000);
	}

	private clearReconnect() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private clearPing() {
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
	}

	private send(obj: unknown) {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(obj));
		}
	}

	subscribeSessions() {
		this.subscribed = true;
		this.send({ ch: "subscribe", topics: ["sessions", "notifications"] });
	}

	openTerminal(id: string, projectId?: string) {
		this.openTerminals.set(id, projectId);
		this.send({ ch: "terminal", id, type: "open", projectId });
	}

	sendInput(id: string, data: string, projectId?: string) {
		this.send({ ch: "terminal", id, type: "data", data, projectId });
	}

	resize(id: string, cols: number, rows: number, projectId?: string) {
		this.send({ ch: "terminal", id, type: "resize", cols, rows, projectId });
	}

	closeTerminal(id: string, projectId?: string) {
		this.openTerminals.delete(id);
		this.send({ ch: "terminal", id, type: "close", projectId });
	}

	disconnect() {
		this.closedByUser = true;
		this.clearReconnect();
		this.clearPing();
		try {
			this.ws?.close();
		} catch {
			/* ignore */
		}
		this.ws = null;
	}
}
