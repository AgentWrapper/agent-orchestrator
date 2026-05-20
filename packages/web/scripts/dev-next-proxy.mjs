import { createServer } from "node:http";
import { createConnection } from "node:net";
import next from "next";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const hostname = process.env.HOST ?? "0.0.0.0";
const app = next({ dev: true, dir: process.cwd(), hostname, port });
const handle = app.getRequestHandler();

function getTerminalProxyTarget(requestUrl) {
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

function proxyTerminalUpgrade(request, socket, head) {
  const targetPath = getTerminalProxyTarget(request.url);
  if (!targetPath) return false;

  const directTerminalPort = Number.parseInt(process.env.DIRECT_TERMINAL_PORT ?? "14801", 10);
  const upstream = createConnection({ host: "127.0.0.1", port: directTerminalPort });

  upstream.on("connect", () => {
    const headers = Object.entries(request.headers)
      .flatMap(([name, value]) => {
        if (Array.isArray(value)) return value.map((item) => `${name}: ${item}`);
        return value === undefined ? [] : [`${name}: ${value}`];
      })
      .join("\r\n");
    upstream.write(`GET ${targetPath} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on("error", () => {
    socket.destroy();
  });
  socket.on("error", () => {
    upstream.destroy();
  });

  return true;
}

await app.prepare();
const handleUpgrade = typeof app.getUpgradeHandler === "function" ? app.getUpgradeHandler() : null;

const server = createServer((req, res) => {
  void handle(req, res);
});

server.on("upgrade", (request, socket, head) => {
  if (proxyTerminalUpgrade(request, socket, head)) {
    return;
  }
  if (handleUpgrade) {
    void handleUpgrade(request, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(port, hostname, () => {
  process.stdout.write(`[next] ready on http://${hostname}:${port}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
