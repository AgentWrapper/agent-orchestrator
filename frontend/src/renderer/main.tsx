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

const router = createAppRouter(queryClient);
void initTelemetry();
startDaemonFailureTelemetry();

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<TelemetryBoundary>
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</TelemetryBoundary>
	</React.StrictMode>,
);
