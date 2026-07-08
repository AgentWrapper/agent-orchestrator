import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { queryClient } from "./lib/query-client";
import { mergeUnreadNotification } from "./lib/notifications";
import { createAppRouter } from "./router";
import { TelemetryBoundary } from "./components/TelemetryBoundary";
import { initTelemetry } from "./lib/telemetry";
import { startDaemonFailureTelemetry } from "./lib/daemon-telemetry";

const router = createAppRouter(queryClient);

if (import.meta.env.DEV) {
	const w = window as never as Record<string, unknown>;
	w.__qc = queryClient;
	// __testNotif("needs_input") — simulates a real notification:
	//   bell count + dock badge update immediately; dock bounces after 3s
	//   (gives you time to click away from AO so the bounce is visible)
	w.__testNotif = async (type: "needs_input" | "ready_to_merge" = "needs_input") => {
		const key = ["notifications", "unread"] as const;
		const id = `test-${Date.now()}`;
		// Freeze the query so window-focus refetch doesn't wipe test data
		queryClient.setQueryDefaults(key, { staleTime: 60_000 });
		await queryClient.cancelQueries({ queryKey: key });
		mergeUnreadNotification(queryClient, {
			id,
			type,
			title: type === "needs_input" ? "Agent needs your input" : "Ready to merge",
			body: "Test notification",
			createdAt: new Date().toISOString(),
			sessionId: "",
			projectId: "",
			prUrl: "",
			target: { kind: "session", sessionId: "" },
			status: "unread",
		});
		console.log("[testNotif] bell updated - click away from AO now, bounce fires in 3s");
		setTimeout(() => {
			void window.ao?.notifications.devBounce();
			// Restore normal stale time after bounce
			queryClient.setQueryDefaults(key, { staleTime: 0 });
		}, 3000);
	};
}

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
