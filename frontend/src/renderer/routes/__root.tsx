import { createRootRouteWithContext, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { TooltipProvider } from "../components/ui/tooltip";
import type { QueryClient } from "@tanstack/react-query";
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

	return (
		<TooltipProvider>
			<Outlet />
		</TooltipProvider>
	);
}
