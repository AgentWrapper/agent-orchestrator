import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ensureRemoteAuthCredentials, ensureRemoteWsTokenSecret } from "./remote-auth.js";
import { proxyTerminalUpgrade } from "./terminal-proxy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

type NextApp = {
  prepare: () => Promise<void>;
  getRequestHandler: () => (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
};

const next = require("next") as (options: {
  dev: boolean;
  dir: string;
  hostname: string;
  port: number;
}) => NextApp;

const pkgRoot = resolve(__dirname, "..");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const hostname = process.env.HOST || "0.0.0.0";

ensureRemoteAuthCredentials();
ensureRemoteWsTokenSecret();
process.env["AO_TRUST_REMOTE_ADDRESS_HEADER"] = "1";

async function main(): Promise<void> {
  const app = next({ dev: true, dir: pkgRoot, hostname, port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const server = createServer((req, res) => {
    req.headers["x-ao-remote-address"] = req.socket.remoteAddress ?? "";
    void handle(req, res);
  });

  server.on("upgrade", (request, socket, head) => {
    if (!proxyTerminalUpgrade(request, socket, head)) {
      socket.destroy();
    }
  });

  server.listen(port, hostname, () => {
    process.stdout.write(`[next-dev] ready on http://${hostname}:${port}\n`);
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[next-dev] failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
