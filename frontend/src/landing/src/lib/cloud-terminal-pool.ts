import { CloudAPI } from "@/lib/cloud-api";

export type CloudTerminalConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";
export type CloudTerminalKind = "agent" | "workspace";

export type CloudTerminalEvent =
  | { type: "state"; state: CloudTerminalConnectionState }
  | { type: "output"; data: Uint8Array }
  | { type: "reset" }
  | { type: "notice"; message: string };

type Listener = (event: CloudTerminalEvent) => void;

interface TerminalServerMessage {
  type: "output" | "error" | "reset" | "replay_complete";
  data?: string;
  message?: string;
  sequence?: number;
}

const maximumHistoryBytes = 4 << 20;

class CloudTerminalConnection {
  private socket: WebSocket | null = null;
  private state: CloudTerminalConnectionState = "connecting";
  private listeners = new Set<Listener>();
  private history: Uint8Array[] = [];
  private historyBytes = 0;
  private lastSequence = 0;
  private reconnectTimer: number | undefined;
  private connectInFlight = false;
  private closed = false;
  private pendingInput: string[] = [];
  private size = { rows: 24, cols: 80 };
  private canOperate = true;

  constructor(
    private readonly api: CloudAPI,
    private readonly orgId: string,
    private readonly sessionId: string,
    private readonly kind: CloudTerminalKind,
  ) {
    window.addEventListener("online", this.reconnectNow);
    window.addEventListener("focus", this.reconnectNow);
    void this.connect();
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener({ type: "state", state: this.state });
    for (const data of this.history) listener({ type: "output", data });
    return () => this.listeners.delete(listener);
  }

  sendInput(data: string) {
    if (!this.canOperate) {
      this.emit({ type: "notice", message: "Terminal is read-only for viewers." });
      return;
    }
    if (this.socket?.readyState !== WebSocket.OPEN) {
      if (this.pendingInput.length < 256) this.pendingInput.push(data);
      this.reconnectNow();
      return;
    }
    this.socket.send(
      JSON.stringify({ type: "input", data: bytesToBase64(data) }),
    );
  }

  resize(rows: number, cols: number) {
    this.size = { rows, cols };
    this.sendResize();
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
    }
    window.removeEventListener("online", this.reconnectNow);
    window.removeEventListener("focus", this.reconnectNow);
    this.socket?.close();
    this.socket = null;
    this.listeners.clear();
  }

  private emit(event: CloudTerminalEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private setState(state: CloudTerminalConnectionState) {
    this.state = state;
    this.emit({ type: "state", state });
  }

  private connect = async () => {
    if (
      this.closed ||
      this.connectInFlight ||
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    this.connectInFlight = true;
    this.setState("connecting");
    try {
      const { ticket, scopes } = await this.api.terminalTicket(
        this.orgId,
        this.sessionId,
        this.kind,
      );
      this.canOperate = scopes?.includes("terminal:operate") ?? true;
      if (this.closed) return;
      const socket = new WebSocket(
        this.api.terminalURL(ticket, this.lastSequence, this.kind),
      );
      this.socket = socket;
      socket.addEventListener("open", () => {
        if (this.socket !== socket || this.closed) return;
        this.setState("connected");
        this.sendResize();
        if (this.canOperate) {
          while (this.pendingInput.length > 0) {
            const input = this.pendingInput.shift();
            if (input) this.sendInput(input);
          }
        } else {
          this.pendingInput = [];
          this.emit({ type: "notice", message: "Terminal is read-only for viewers." });
        }
      });
      socket.addEventListener("message", (event) => {
        if (this.socket !== socket || this.closed) return;
        const message = JSON.parse(String(event.data)) as TerminalServerMessage;
        this.lastSequence = Math.max(this.lastSequence, message.sequence ?? 0);
        if (message.type === "reset") {
          this.history = [];
          this.historyBytes = 0;
          this.emit({ type: "reset" });
          return;
        }
        if (message.type === "error") {
          this.emit({
            type: "notice",
            message: message.message ?? "Terminal command could not be queued.",
          });
          return;
        }
        if (message.type === "replay_complete") {
          if (!this.canOperate) {
            this.history = [];
            this.historyBytes = 0;
            this.emit({ type: "reset" });
            this.forceRedraw();
          }
          return;
        }
        if (message.type !== "output" || !message.data) return;
        const data = base64ToBytes(message.data);
        this.history.push(data);
        this.historyBytes += data.byteLength;
        while (
          this.historyBytes > maximumHistoryBytes &&
          this.history.length > 1
        ) {
          this.historyBytes -= this.history.shift()?.byteLength ?? 0;
        }
        this.emit({ type: "output", data });
      });
      socket.addEventListener("close", () => {
        if (this.socket !== socket || this.closed) return;
        this.socket = null;
        this.setState("disconnected");
        this.scheduleReconnect(1_000);
      });
      socket.addEventListener("error", () => {
        if (this.socket === socket && !this.closed) this.setState("error");
      });
    } catch {
      if (!this.closed) {
        this.setState("error");
        this.scheduleReconnect(2_000);
      }
    } finally {
      this.connectInFlight = false;
    }
  };

  private scheduleReconnect(delay: number) {
    if (this.closed) return;
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  private reconnectNow = () => {
    if (this.socket?.readyState === WebSocket.OPEN || this.closed) return;
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    void this.connect();
  };

  private sendResize() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "resize", ...this.size }));
  }

  private forceRedraw() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const temporaryCols = this.size.cols > 1 ? this.size.cols - 1 : 2;
    this.socket.send(
      JSON.stringify({
        type: "resize",
        rows: this.size.rows,
        cols: temporaryCols,
      }),
    );
    this.sendResize();
  }
}

let poolAPI: CloudAPI | null = null;
const connections = new Map<string, CloudTerminalConnection>();

export function ensureCloudTerminalConnection(
  api: CloudAPI,
  orgId: string,
  sessionId: string,
  kind: CloudTerminalKind = "agent",
) {
  if (poolAPI && poolAPI !== api) clearCloudTerminalConnections();
  poolAPI = api;
  const key = `${orgId}:${sessionId}:${kind}`;
  const existing = connections.get(key);
  if (existing) return existing;
  const connection = new CloudTerminalConnection(api, orgId, sessionId, kind);
  connections.set(key, connection);
  return connection;
}

export function syncCloudTerminalConnections(
  api: CloudAPI,
  orgId: string,
  sessionIds: string[],
) {
  if (poolAPI && poolAPI !== api) clearCloudTerminalConnections();
  poolAPI = api;
  const active = new Set(sessionIds);
  for (const [key, connection] of connections) {
    const [, sessionId] = key.split(":");
    if (active.has(sessionId)) continue;
    connection.close();
    connections.delete(key);
  }
}

export function clearCloudTerminalConnections() {
  for (const connection of connections.values()) connection.close();
  connections.clear();
  poolAPI = null;
}

function bytesToBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
