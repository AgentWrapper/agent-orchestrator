import type { AoBridge } from "../preload";

declare global {
	interface Window {
		ao?: AoBridge;
	}

	interface ImportMetaEnv {
		readonly VITE_AO_POSTHOG_KEY?: string;
		readonly VITE_AO_POSTHOG_HOST?: string;
	}

	const __AO_RENDERER_FRONTEND_TREE__: string;
}

export {};
