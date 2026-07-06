// defineConfig comes from vitest/config (a superset of vite's) so the `test`
// block typechecks; vitest itself must be pointed at this file explicitly
// (package.json test script) because it only auto-discovers vite.config.*.
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import { fileURLToPath, URL } from "node:url";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { DEFAULT_POSTHOG_HOST } from "./src/shared/posthog-config";

const POSTHOG_ORIGIN = (() => {
	const configured = process.env.VITE_AO_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;
	if (!configured) return "";
	try {
		return new URL(configured).origin;
	} catch {
		return "";
	}
})();

const SAME_ORIGIN_BROWSER_BUILD = process.env.VITE_NO_ELECTRON === "1" && (process.env.VITE_AO_API_BASE_URL ?? "") === "";
const CONNECT_SRC = [
	"'self'",
	...(SAME_ORIGIN_BROWSER_BUILD ? [] : ["http://127.0.0.1:*", "ws://127.0.0.1:*"]),
	POSTHOG_ORIGIN,
].filter(Boolean);

// CSP for the built renderer. Electron/package builds need loopback daemon
// access; production browser builds use same-origin proxying and should not
// grant the tailnet page access to a viewer machine's loopback services.
// Injected at build time rather than written into index.html because the dev
// server needs inline scripts (react-refresh preamble) that a static meta tag
// would block.
const CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"font-src 'self' data:",
	["connect-src", ...CONNECT_SRC].join(" "),
	"object-src 'none'",
	"base-uri 'self'",
	"frame-src 'none'",
].join("; ");

const injectCspMeta: Plugin = {
	name: "inject-csp-meta",
	apply: "build",
	transformIndexHtml() {
		return [
			{
				tag: "meta",
				attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY },
				injectTo: "head-prepend",
			},
		];
	},
};

export default defineConfig({
	// "@/" → the renderer root (src/renderer), the shadcn/ui import convention.
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src/renderer", import.meta.url)),
		},
	},
	// Dev proxy for VITE_NO_ELECTRON=1 browser preview — forwards /api and /mux
	// to the daemon so the renderer can be tested against a running daemon from
	// a plain browser without an Electron shell.
	server: {
		proxy: {
			"/api": {
				target: process.env.AO_DEV_API_TARGET ?? "http://127.0.0.1:3001",
				changeOrigin: false,
			},
			"/healthz": {
				target: process.env.AO_DEV_API_TARGET ?? "http://127.0.0.1:3001",
				changeOrigin: false,
			},
			"/readyz": {
				target: process.env.AO_DEV_API_TARGET ?? "http://127.0.0.1:3001",
				changeOrigin: false,
			},
			"/mux": {
				target: process.env.AO_DEV_API_TARGET ?? "http://127.0.0.1:3001",
				changeOrigin: false,
				ws: true,
			},
		},
	},
	plugins: [
		TanStackRouterVite({
			routesDirectory: "./src/renderer/routes",
			generatedRouteTree: "./src/renderer/routeTree.gen.ts",
			target: "react",
			autoCodeSplitting: true,
		}),
		react(),
		tailwindcss(),
		injectCspMeta,
	],
	test: {
		environment: "jsdom",
		testTimeout: 20_000,
		// Anchor node_modules at any depth: a bare "node_modules/**" replaces
		// vitest's default "**/node_modules/**" and only matches the root, so the
		// tracked src/landing preview app's nested node_modules would otherwise
		// have its vendored third-party test suites collected and run.
		exclude: ["**/node_modules/**", "dist/**", "dist-electron/**", "e2e/**"],
		globals: true,
		setupFiles: "./src/renderer/test/setup.ts",
	},
});
