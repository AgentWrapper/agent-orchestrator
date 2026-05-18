import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const homeDir = os.homedir().replace(/\\/g, "/");
const nextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: [
    "@aoagents/ao-plugin-agent-claude-code",
    "@aoagents/ao-plugin-agent-codex",
    "@aoagents/ao-plugin-agent-opencode",
    "@aoagents/ao-plugin-runtime-tmux",
    "@aoagents/ao-plugin-scm-github",
    "@aoagents/ao-plugin-tracker-github",
    "@aoagents/ao-plugin-tracker-linear",
    "@aoagents/ao-plugin-workspace-worktree",
  ],
  serverExternalPackages: [
    "yaml",
    "zod",
    "@aoagents/ao-core",
    "better-sqlite3",
    // chokidar pulls in fsevents on macOS — a native .node binary webpack
    // can't bundle. The artifact watcher only runs in the standalone WebSocket
    // server (packages/web/server/mux-websocket.ts), but ao-core's barrel
    // re-exports `startArtifactWatcher`, so any route handler importing from
    // @aoagents/ao-core (e.g. /api/orchestrators) drags chokidar through
    // webpack. Externalizing leaves the require() alone at runtime.
    "chokidar",
    "fsevents",
  ],
  webpack: (config, { isServer, webpack }) => {
    // chokidar (used by the artifact watcher in ao-core) requires fsevents
    // dynamically on macOS. fsevents ships a .node binary that webpack can't
    // bundle. Externalize it on the server build (artifact watcher runs in the
    // standalone mux-websocket process, not in route handlers — but ao-core's
    // barrel pulls it in transitively). On the client build, replace it with
    // an empty module since chokidar is never run in the browser.
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals]),
        ({ request }, callback) => {
          if (request === "fsevents") {
            return callback(null, "commonjs fsevents");
          }
          callback();
        },
      ];
    } else {
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        chokidar: false,
        fsevents: false,
      };
    }

    if (process.platform === "win32") {
      config.snapshot = {
        ...config.snapshot,
        managedPaths: [/^(.+?[\\/]node_modules[\\/])/],
      };
      // Prevent nft from globbing the home directory during server file tracing.
      // ao-core resolves paths like ~/.agent-orchestrator at runtime; nft tries to
      // scan them at build time and hits EPERM on Windows junction points
      // (e.g. C:\Users\<user>\Application Data).
      if (isServer) {
        const tracePlugin = config.plugins.find(
          (p) => p.constructor?.name === "TraceEntryPointsPlugin"
        );
        if (tracePlugin) {
          tracePlugin.traceIgnores = [
            ...(tracePlugin.traceIgnores ?? []),
            `${homeDir}/**`,
          ];
        }
      }
    }
    return config;
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

// Only load bundle analyzer when ANALYZE=true (dev-only dependency)
let config = nextConfig;
if (process.env.ANALYZE === "true") {
  const { default: bundleAnalyzer } = await import("@next/bundle-analyzer");
  config = bundleAnalyzer({ enabled: true })(nextConfig);
}

export default config;
