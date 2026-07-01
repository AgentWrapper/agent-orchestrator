import { create } from "zustand";

export type Theme = "light" | "dark";
/** Worker detail view toggles — Changes (Git rail) is the default. */
export type WorkbenchTab = "changes" | "files" | "terminal";

export type OrchestratorReplacementError = {
	projectId: string;
	projectName?: string;
	message: string;
};

// Selection (which project/session is open) now lives in the URL — the router
// is the single source of truth, read via route params. This store holds only
// ephemeral, route-independent UI: theme, sidebar/inspector collapse, and the
// active workbench tab within a session.
type UiState = {
	workbenchTab: WorkbenchTab;
	isSidebarOpen: boolean;
	isInspectorOpen: boolean;
	theme: Theme;
	restartingProjectIds: Set<string>;
	orchestratorReplacementError?: OrchestratorReplacementError;
	setWorkbenchTab: (tab: WorkbenchTab) => void;
	setTheme: (theme: Theme) => void;
	toggleTheme: () => void;
	toggleSidebar: () => void;
	toggleInspector: () => void;
	startOrchestratorRestart: (projectId: string) => void;
	finishOrchestratorRestart: (projectId: string) => void;
	setOrchestratorReplacementError: (error: OrchestratorReplacementError) => void;
	clearOrchestratorReplacementError: () => void;
};

const sidebarStorageKey = "ao.sidebar.open";
const inspectorStorageKey = "ao.inspector.open";
const themeStorageKey = "ao.theme";

function getLocalStorage() {
	if (typeof window === "undefined" || !window.localStorage) return null;
	return window.localStorage;
}

function initialSidebarOpen() {
	return getLocalStorage()?.getItem(sidebarStorageKey) !== "false";
}

function initialInspectorOpen() {
	return getLocalStorage()?.getItem(inspectorStorageKey) !== "false";
}

function systemTheme(): Theme {
	if (typeof window === "undefined") return "dark";
	return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function initialTheme(): Theme {
	const stored = getLocalStorage()?.getItem(themeStorageKey);
	if (stored === "light" || stored === "dark") return stored;
	return systemTheme();
}

export function readStoredTheme(): Theme | null {
	const stored = getLocalStorage()?.getItem(themeStorageKey);
	return stored === "light" || stored === "dark" ? stored : null;
}

export const useUiStore = create<UiState>((set) => ({
	workbenchTab: "changes",
	isSidebarOpen: initialSidebarOpen(),
	isInspectorOpen: initialInspectorOpen(),
	theme: initialTheme(),
	restartingProjectIds: new Set<string>(),
	setWorkbenchTab: (workbenchTab) => set({ workbenchTab }),
	setTheme: (theme) => {
		getLocalStorage()?.setItem(themeStorageKey, theme);
		set({ theme });
	},
	toggleTheme: () =>
		set((state) => {
			const theme = state.theme === "dark" ? "light" : "dark";
			getLocalStorage()?.setItem(themeStorageKey, theme);
			return { theme };
		}),
	toggleSidebar: () =>
		set((state) => {
			const isSidebarOpen = !state.isSidebarOpen;
			getLocalStorage()?.setItem(sidebarStorageKey, String(isSidebarOpen));
			return { isSidebarOpen };
		}),
	toggleInspector: () =>
		set((state) => {
			const isInspectorOpen = !state.isInspectorOpen;
			getLocalStorage()?.setItem(inspectorStorageKey, String(isInspectorOpen));
			return { isInspectorOpen };
		}),
	startOrchestratorRestart: (projectId) =>
		set((state) => {
			const restartingProjectIds = new Set(state.restartingProjectIds);
			restartingProjectIds.add(projectId);
			return { restartingProjectIds };
		}),
	finishOrchestratorRestart: (projectId) =>
		set((state) => {
			const restartingProjectIds = new Set(state.restartingProjectIds);
			restartingProjectIds.delete(projectId);
			return { restartingProjectIds };
		}),
	setOrchestratorReplacementError: (orchestratorReplacementError) => set({ orchestratorReplacementError }),
	clearOrchestratorReplacementError: () => set({ orchestratorReplacementError: undefined }),
}));
