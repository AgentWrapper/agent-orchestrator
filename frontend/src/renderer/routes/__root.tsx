import { createRootRouteWithContext, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { TooltipProvider } from "../components/ui/tooltip";
import type { QueryClient } from "@tanstack/react-query";
import { systemBrowserHrefFromClick } from "../../shared/system-browser-links";
import { aoBridge } from "../lib/bridge";
import { captureRendererEvent, routeSurface } from "../lib/telemetry";

export const Route = createRootRouteWithContext<{
	queryClient: QueryClient;
}>()({
	component: RootComponent,
});

function RootComponent() {
	const location = useRouterState({ select: (state) => state.location });

	useEffect(() => {
		void captureRendererEvent("ao.renderer.route_viewed", {
			surface: routeSurface(location.pathname),
		});
	}, [location.pathname]);

	useEffect(() => {
		const openModifiedLink = (event: MouseEvent) => {
			const href = systemBrowserHrefFromClick(event);
			if (!href) return;
			event.preventDefault();
			event.stopPropagation();
			void aoBridge.app.openExternal(href).catch((error) => {
				console.warn("Unable to open link in system browser", error);
			});
		};
		document.addEventListener("click", openModifiedLink, true);
		return () => document.removeEventListener("click", openModifiedLink, true);
	}, []);

	return (
		<TooltipProvider>
			<Outlet />
		</TooltipProvider>
	);
}
