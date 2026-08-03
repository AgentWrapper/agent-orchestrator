import "./lib/apply-initial-theme";
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { I18nextProvider } from "react-i18next";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { queryClient } from "./lib/query-client";
import { createAppRouter } from "./router";
import { TelemetryBoundary } from "./components/TelemetryBoundary";
import { initTelemetry } from "./lib/telemetry";
import { startDaemonFailureTelemetry } from "./lib/daemon-telemetry";
import { startUpdateTelemetry } from "./lib/update-telemetry";
import { appI18n } from "./i18n";
import { useLocaleStore } from "./stores/locale-store";

const router = createAppRouter(queryClient);
void initTelemetry();
startDaemonFailureTelemetry();
startUpdateTelemetry();

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

async function renderApp(): Promise<void> {
	// Resolve the persisted locale before mounting so translated text never
	// flashes in English for users who selected another language.
	await useLocaleStore.getState().load();
	createRoot(document.getElementById("root") as HTMLElement).render(
		<React.StrictMode>
			<I18nextProvider i18n={appI18n}>
				<TelemetryBoundary>
					<QueryClientProvider client={queryClient}>
						<RouterProvider router={router} />
					</QueryClientProvider>
				</TelemetryBoundary>
			</I18nextProvider>
		</React.StrictMode>,
	);
}

void renderApp();
