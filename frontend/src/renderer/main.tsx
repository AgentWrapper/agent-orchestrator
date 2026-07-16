import "./lib/apply-initial-theme";
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { queryClient } from "./lib/query-client";
import { createAppRouter } from "./router";
import { TelemetryBoundary } from "./components/TelemetryBoundary";
import { initTelemetry } from "./lib/telemetry";
import { startDaemonFailureTelemetry } from "./lib/daemon-telemetry";
import { aoBridge } from "./lib/bridge";
import { applyLocaleSnapshot, resolveNavigatorLocaleSnapshot } from "./i18n";

type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
	interface Register {
		router: AppRouter;
	}
}

async function bootstrap(): Promise<void> {
	const snapshot = await aoBridge.locale.get().catch(() => resolveNavigatorLocaleSnapshot());
	await applyLocaleSnapshot(snapshot);

	const router = createAppRouter(queryClient);
	void initTelemetry();
	startDaemonFailureTelemetry();

	createRoot(document.getElementById("root") as HTMLElement).render(
		<React.StrictMode>
			<TelemetryBoundary>
				<QueryClientProvider client={queryClient}>
					<RouterProvider router={router} />
				</QueryClientProvider>
			</TelemetryBoundary>
		</React.StrictMode>,
	);
}

void bootstrap();
