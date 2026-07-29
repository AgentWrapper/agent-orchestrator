import "./lib/apply-initial-theme";
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ClerkProvider, useAuth } from "@clerk/clerk-react";
import "@xterm/xterm/css/xterm.css";
// Bundle JetBrains Mono (SIL OFL) so the terminal renders a premium, consistent
// monospace everywhere instead of falling back to the OS default (Menlo/SF Mono)
// when no Nerd Font is installed. 400 = normal, 700 = bold ANSI.
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./styles.css";
import { queryClient } from "./lib/query-client";
import { createAppRouter } from "./router";
import { TelemetryBoundary } from "./components/TelemetryBoundary";
import { initTelemetry } from "./lib/telemetry";
import { startDaemonFailureTelemetry } from "./lib/daemon-telemetry";
import { setCloudAuthTokenGetter, getControlPlaneBaseUrl } from "./lib/api-client";
import { setCloudSignedIn } from "./stores/cloud-auth-store";
import { workspaceQueryKey } from "./hooks/useWorkspaceQuery";
import { aoBridge } from "./lib/bridge";

// Publishable keys are public by design (Clerk embeds them in client code). The
// fallback is our dev instance so cloud sign-in works out of the box; override
// per environment with VITE_CLERK_PUBLISHABLE_KEY (e.g. a pk_live_… for prod).
const CLERK_PUBLISHABLE_KEY =
	(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined) ??
	"pk_test_dmFsdWVkLXdlYXNlbC0wLmNsZXJrLmFjY291bnRzLmRldiQ";

// Bridges Clerk's session token to the API client so control-plane cloud calls
// carry an Authorization: Bearer JWT. Renders nothing; lives inside ClerkProvider.
function CloudAuthBridge(): null {
	const { getToken, isSignedIn } = useAuth();
	React.useEffect(() => {
		setCloudAuthTokenGetter(async () => {
			try {
				return await getToken();
			} catch {
				return null;
			}
		});
		return () => setCloudAuthTokenGetter(null);
	}, [getToken]);

	// Publish sign-in state to the shared store and force an immediate board
	// refetch on any transition, so cloud sessions appear on sign-in / vanish on
	// sign-out at once (not after the 15s workspace poll). Local sessions are
	// untouched — only the cloud merge is gated on auth.
	React.useEffect(() => {
		setCloudSignedIn(Boolean(isSignedIn));
		void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
	}, [isSignedIn]);

	// Keep the local daemon's bus credentials in sync with the Clerk session so a
	// LOCAL orchestrator/worker can take part in the federated bus. Mints a
	// longer-lived, tenant-scoped bus token from the control plane and hands it to
	// the daemon (via the main process); clears it on sign-out. Best-effort.
	React.useEffect(() => {
		let cancelled = false;
		async function sync() {
			const cpUrl = getControlPlaneBaseUrl();
			if (!isSignedIn || !cpUrl) {
				await aoBridge.cloud.clearBusCredentials().catch(() => undefined);
				return;
			}
			try {
				const clerkToken = await getToken();
				if (!clerkToken || cancelled) return;
				const resp = await fetch(`${cpUrl}/api/v1/cloud/bus/token`, {
					method: "POST",
					headers: { Authorization: `Bearer ${clerkToken}`, "Content-Type": "application/json" },
					body: "{}",
				});
				if (!resp.ok || cancelled) return;
				const data = (await resp.json()) as { token?: string };
				if (!data.token || cancelled) return;
				await aoBridge.cloud.setBusCredentials({ controlPlaneUrl: cpUrl, token: data.token });
			} catch {
				// Transient — retried on the next tick / sign-in change.
			}
		}
		void sync();
		const refresh = setInterval(() => void sync(), 6 * 60 * 60 * 1000); // token ~12h
		return () => {
			cancelled = true;
			clearInterval(refresh);
		};
	}, [isSignedIn, getToken]);
	return null;
}

const router = createAppRouter(queryClient);
void initTelemetry();
startDaemonFailureTelemetry();

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

const appTree = (
	<React.StrictMode>
		<TelemetryBoundary>
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</TelemetryBoundary>
	</React.StrictMode>
);

// ClerkProvider renders children immediately (auth loads async), so the local
// app is fully usable even if Clerk is unreachable — only cloud sign-in waits.
createRoot(document.getElementById("root") as HTMLElement).render(
	CLERK_PUBLISHABLE_KEY ? (
		// Force post-auth navigation back to the board ("/"). Without this, an OAuth
		// (Continue with Google) redirect lands on Clerk's callback URL, which the
		// app's router doesn't render → a blank screen after signing in.
		<ClerkProvider
			publishableKey={CLERK_PUBLISHABLE_KEY}
			signInForceRedirectUrl="/"
			signUpForceRedirectUrl="/"
			signInFallbackRedirectUrl="/"
			signUpFallbackRedirectUrl="/"
		>
			<CloudAuthBridge />
			{appTree}
		</ClerkProvider>
	) : (
		appTree
	),
);
