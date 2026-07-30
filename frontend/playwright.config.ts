import { defineConfig } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 5173);

export default defineConfig({
	testDir: "e2e",
	use: {
		baseURL: `http://127.0.0.1:${port}`,
	},
	webServer: {
		// dev:web serves the renderer alone (VITE_NO_ELECTRON=1) — no Electron child to
		// launch, which is all the browser-based e2e suite needs.
		command: `npm run dev:web -- --port ${port} --host 127.0.0.1`,
		port,
		reuseExistingServer: !process.env.CI,
	},
});
