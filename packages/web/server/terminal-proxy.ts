import { type IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import { type Duplex } from "node:stream";
import {
  activeRemoteAuth,
  isBasicAuthHeaderAllowed,
  verifyRemoteWsToken,
  type RemoteAuthCredentials,
} from "./remote-auth.js";

export function getTerminalProxyTarget(requestUrl: string | undefined): string | null {
  const url = new URL(requestUrl ?? "/", "ws://localhost");
  if (url.pathname === "/ao-terminal-mux") {
    url.pathname = "/mux";
    return `${url.pathname}${url.search}`;
  }
  if (url.pathname.startsWith("/ao-terminal/")) {
    url.pathname = url.pathname.slice("/ao-terminal".length);
    return `${url.pathname}${url.search}`;
  }
  return null;
}

export function isRemoteUpgradeAllowed(
  request: IncomingMessage,
  initialConfiguredAuth?: RemoteAuthCredentials,
): boolean {
  const expected = activeRemoteAuth(initialConfiguredAuth);
  if (!expected.password) return true;

  const url = new URL(request.url ?? "/", "ws://localhost");
  if (verifyRemoteWsToken(url.searchParams.get("auth_token"), expected)) {
    return true;
  }

  return isBasicAuthHeaderAllowed(request.headers.authorization, expected);
}

function headerValues(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

export function buildWebSocketUpgradeHeaders(request: IncomingMessage): string {
  const lines: string[] = [];
  const append = (name: string, values: string[]) => {
    for (const value of values) {
      lines.push(`${name}: ${value}`);
    }
  };

  append("host", headerValues(request.headers.host));
  append("upgrade", headerValues(request.headers.upgrade));
  append("connection", headerValues(request.headers.connection));

  for (const [name, value] of Object.entries(request.headers)) {
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith("sec-websocket-")) {
      append(name, headerValues(value));
    }
  }

  append("x-ao-remote-address", headerValues(request.headers["x-ao-remote-address"]));
  return lines.join("\r\n");
}

export function proxyTerminalUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  initialConfiguredAuth?: RemoteAuthCredentials,
): boolean {
  const targetPath = getTerminalProxyTarget(request.url);
  if (!targetPath) return false;
  if (!isRemoteUpgradeAllowed(request, initialConfiguredAuth)) {
    socket.destroy();
    return true;
  }

  const directTerminalPort = Number.parseInt(process.env["DIRECT_TERMINAL_PORT"] ?? "14801", 10);
  const upstream = createConnection({ host: "127.0.0.1", port: directTerminalPort });

  upstream.on("connect", () => {
    const headers = buildWebSocketUpgradeHeaders(request);
    upstream.write(`GET ${targetPath} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on("error", () => {
    socket.destroy();
  });
  upstream.on("close", () => {
    socket.destroy();
  });
  socket.on("error", () => {
    upstream.destroy();
  });
  socket.on("close", () => {
    upstream.destroy();
  });

  return true;
}
