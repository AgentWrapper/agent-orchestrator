import { defineConfig } from "@playwright/test";

// Real-app harness: no webServer, no browser. Playwright launches the REAL
// packaged Electron app (via _electron.launch) inside the pod under xvfb.
export default defineConfig({
	testDir: ".",
	testMatch: /real-app\.spec\.ts/,
	timeout: 90_000,
	reporter: "line",
	workers: 1,
});
