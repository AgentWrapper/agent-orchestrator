import { createFileRoute, useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useUiStore } from "../stores/ui-store";

export const Route = createFileRoute("/_shell/settings")({
	component: LegacyGlobalSettingsRoute,
});

// Deep-link / bookmark shim: settings is a modal now. Open it, then leave this
// route so the page underneath is whatever the user was on (not forced to "/").
function LegacyGlobalSettingsRoute() {
	const navigate = useNavigate();
	const router = useRouter();
	const canGoBack = useCanGoBack();
	const openGlobalSettings = useUiStore((state) => state.openGlobalSettings);
	const didOpen = useRef(false);

	useEffect(() => {
		if (didOpen.current) return;
		didOpen.current = true;
		openGlobalSettings();
		if (canGoBack) {
			router.history.back();
		} else {
			void navigate({ to: "/", replace: true });
		}
	}, [canGoBack, navigate, openGlobalSettings, router]);

	return null;
}
