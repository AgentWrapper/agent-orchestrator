import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "e2e",
	use: {
		baseURL: "http://127.0.0.1:5173",
	},
	webServer: {
		// dev:web serves the renderer alone (VITE_NO_ELECTRON=1) — no Electron child to
		// launch, which is all the browser-based e2e suite needs.
		command: "npm run dev:web -- --port 5173 --host 127.0.0.1",
		port: 5173,
		reuseExistingServer: !process.env.CI,
	},
});
