import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const homeDir = os.homedir().replace(/\\/g, "/");
// Next does not expose a public helper for extending the default
// htmlLimitedBots list. Keep the default Next 15 crawler coverage here and add
// only narrow audit UAs, avoiding private next/dist imports in runtime config.
const nextDefaultHtmlLimitedBotsSource = String.raw`[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight`;
const htmlLimitedBots = new RegExp(
  `${nextDefaultHtmlLimitedBotsSource}|Lighthouse|PageSpeed`,
  "i",
);
const nextConfig = {
  // Preserve Next's crawler list and add narrow audit UAs without matching
  // ordinary Chrome/Chromium browser traffic.
  htmlLimitedBots,
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: [
    "@aoagents/ao-core",
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
  ],
  webpack: (config, { isServer }) => {
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
