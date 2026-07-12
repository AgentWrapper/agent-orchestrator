import { create } from "zustand";
import { resolveTheme, themeStorageKey, type Theme } from "../lib/theme";

export type { Theme } from "../lib/theme";
export { readStoredTheme } from "../lib/theme";

/** Worker detail view toggles — Changes (Git rail) is the default. */
export type WorkbenchTab = "changes" | "files" | "terminal";

// Selection (which project/session is open) now lives in the URL — the router
// is the single source of truth, read via route params. This store holds only
// ephemeral, route-independent UI: theme, sidebar/inspector collapse, and the
// active workbench tab within a session.
type UiState = {
	workbenchTab: WorkbenchTab;
	isSidebarOpen: boolean;
	isInspectorOpen: boolean;
	theme: Theme;
	restartingProjectIds: ReadonlySet<string>;
	orchestratorReplacementErrors: Record<string, string>;
	orchestratorStartupErrors: Record<string, string>;
	setWorkbenchTab: (tab: WorkbenchTab) => void;
	setTheme: (theme: Theme) => void;
	toggleTheme: () => void;
	toggleSidebar: () => void;
	toggleInspector: () => void;
	setProjectRestarting: (projectId: string, restarting: boolean) => void;
	setOrchestratorReplacementError: (projectId: string, message: string | null) => void;
	setOrchestratorStartupError: (projectId: string, message: string | null) => void;
};

const sidebarStorageKey = "ao.sidebar.open";
const inspectorStorageKey = "ao.inspector.open";

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

export const useUiStore = create<UiState>((set) => ({
	workbenchTab: "changes",
	isSidebarOpen: initialSidebarOpen(),
	isInspectorOpen: initialInspectorOpen(),
	theme: resolveTheme(),
	restartingProjectIds: new Set<string>(),
	orchestratorReplacementErrors: {},
	orchestratorStartupErrors: {},
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
	setProjectRestarting: (projectId, restarting) =>
		set((state) => {
			const restartingProjectIds = new Set(state.restartingProjectIds);
			if (restarting) {
				restartingProjectIds.add(projectId);
			} else {
				restartingProjectIds.delete(projectId);
			}
			return { restartingProjectIds };
		}),
	setOrchestratorReplacementError: (projectId, message) =>
		set((state) => {
			const orchestratorReplacementErrors = { ...state.orchestratorReplacementErrors };
			if (message) {
				orchestratorReplacementErrors[projectId] = message;
			} else {
				delete orchestratorReplacementErrors[projectId];
			}
			return { orchestratorReplacementErrors };
		}),
	setOrchestratorStartupError: (projectId, message) =>
		set((state) => {
			const orchestratorStartupErrors = { ...state.orchestratorStartupErrors };
			if (message) {
				orchestratorStartupErrors[projectId] = message;
			} else {
				delete orchestratorStartupErrors[projectId];
			}
			return { orchestratorStartupErrors };
		}),
}));
