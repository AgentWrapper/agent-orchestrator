import { create } from "zustand";
import {
	readStoredThemePreference,
	resolveTheme,
	systemTheme,
	themeStorageKey,
	type Theme,
	type ThemePreference,
} from "../lib/theme";

export type { Theme, ThemePreference } from "../lib/theme";
export { readStoredThemePreference, resolveTheme } from "../lib/theme";

/** Worker detail view toggles — Changes (Git rail) is the default. */
export type WorkbenchTab = "changes" | "files" | "terminal";
export type InspectorView = "summary" | "reviews" | "browser" | "files";

export type InspectorSessionState = {
	isOpen: boolean;
	view: InspectorView;
	previewKey?: string;
};

// Selection (which project/session is open) now lives in the URL — the router
// is the single source of truth, read via route params. This store holds only
// ephemeral UI: theme, sidebar collapse, command palette, per-session inspector
// state, and the active workbench tab within a session.
type UiState = {
	workbenchTab: WorkbenchTab;
	isSidebarOpen: boolean;
	inspectorSessions: Record<string, InspectorSessionState>;
	isCommandPaletteOpen: boolean;
	themePreference: ThemePreference;
	/** Resolved light/dark for React consumers; may track OS while preference is system. */
	resolvedTheme: Theme;
	restartingProjectIds: ReadonlySet<string>;
	orchestratorReplacementErrors: Record<string, string>;
	orchestratorStartupErrors: Record<string, string>;
	// Transient "open the New Task dialog for this project" signal. The nonce
	// bumps on every request so a repeat press (even for the same project) still
	// re-fires; the always-mounted GlobalNewTaskDialog consumes it. Selection
	// still lives in the URL — this is a one-shot action, not persisted state.
	newTaskRequest: { projectId: string; nonce: number } | null;
	// Bumps to ask the sidebar's create-project flow to open (the ⌘N fallback
	// when no project is in scope).
	createProjectNonce: number;
	// Bumps to ask for a new standalone shell terminal. Like newTaskRequest this
	// is a one-shot signal, not state: the topbar button and Ctrl+` both raise it
	// so they cannot drift apart, and a repeat press re-fires because the nonce
	// always changes. The shell layout is its single consumer — it is mounted on
	// every route, so the request is honoured from anywhere in the app.
	newShellTerminalNonce: number;
	// The shell terminal the user most recently opened or selected. Both the
	// session view (tabs beside the session's pane) and the standalone terminals
	// view read it, so whichever one is on screen shows the same shell.
	activeShellTerminalHandleId: string | null;
	setWorkbenchTab: (tab: WorkbenchTab) => void;
	setThemePreference: (theme: ThemePreference) => void;
	/** Refresh resolvedTheme from OS without writing light/dark to storage. */
	syncSystemTheme: () => void;
	toggleSidebar: () => void;
	setInspectorOpen: (sessionId: string, isOpen: boolean) => void;
	toggleInspector: (sessionId: string) => void;
	setInspectorView: (sessionId: string, view: InspectorView) => void;
	markInspectorPreviewSeen: (sessionId: string, previewKey: string) => void;
	setCommandPaletteOpen: (open: boolean) => void;
	setProjectRestarting: (projectId: string, restarting: boolean) => void;
	setOrchestratorReplacementError: (projectId: string, message: string | null) => void;
	setOrchestratorStartupError: (projectId: string, message: string | null) => void;
	requestNewTask: (projectId: string) => void;
	requestCreateProject: () => void;
	requestNewShellTerminal: () => void;
	setActiveShellTerminal: (handleId: string | null) => void;
};

const sidebarStorageKey = "ao.sidebar.open";

function getLocalStorage() {
	if (typeof window === "undefined" || !window.localStorage) return null;
	return window.localStorage;
}

function initialSidebarOpen() {
	return getLocalStorage()?.getItem(sidebarStorageKey) !== "false";
}

function inspectorState(sessions: Record<string, InspectorSessionState>, sessionId: string): InspectorSessionState {
	return sessions[sessionId] ?? { isOpen: false, view: "summary" };
}

const initialThemePreference = readStoredThemePreference();

export const useUiStore = create<UiState>((set) => ({
	workbenchTab: "changes",
	isSidebarOpen: initialSidebarOpen(),
	inspectorSessions: {},
	isCommandPaletteOpen: false,
	themePreference: initialThemePreference,
	resolvedTheme: resolveTheme(initialThemePreference),
	restartingProjectIds: new Set<string>(),
	orchestratorReplacementErrors: {},
	orchestratorStartupErrors: {},
	newTaskRequest: null,
	createProjectNonce: 0,
	newShellTerminalNonce: 0,
	activeShellTerminalHandleId: null,
	setWorkbenchTab: (workbenchTab) => set({ workbenchTab }),
	setThemePreference: (themePreference) => {
		getLocalStorage()?.setItem(themeStorageKey, themePreference);
		set({ themePreference, resolvedTheme: resolveTheme(themePreference) });
	},
	syncSystemTheme: () =>
		set((state) => {
			if (state.themePreference !== "system") return state;
			const next = systemTheme();
			return next === state.resolvedTheme ? state : { resolvedTheme: next };
		}),
	toggleSidebar: () =>
		set((state) => {
			const isSidebarOpen = !state.isSidebarOpen;
			getLocalStorage()?.setItem(sidebarStorageKey, String(isSidebarOpen));
			return { isSidebarOpen };
		}),
	setInspectorOpen: (sessionId, isOpen) =>
		set((state) => {
			const current = inspectorState(state.inspectorSessions, sessionId);
			return {
				inspectorSessions: {
					...state.inspectorSessions,
					[sessionId]: { ...current, isOpen },
				},
			};
		}),
	toggleInspector: (sessionId) =>
		set((state) => {
			const current = inspectorState(state.inspectorSessions, sessionId);
			return {
				inspectorSessions: {
					...state.inspectorSessions,
					[sessionId]: { ...current, isOpen: !current.isOpen },
				},
			};
		}),
	setInspectorView: (sessionId, view) =>
		set((state) => {
			const current = inspectorState(state.inspectorSessions, sessionId);
			return {
				inspectorSessions: {
					...state.inspectorSessions,
					[sessionId]: { ...current, view },
				},
			};
		}),
	markInspectorPreviewSeen: (sessionId, previewKey) =>
		set((state) => {
			const current = inspectorState(state.inspectorSessions, sessionId);
			return {
				inspectorSessions: {
					...state.inspectorSessions,
					[sessionId]: { ...current, previewKey },
				},
			};
		}),
	setCommandPaletteOpen: (isCommandPaletteOpen) => set({ isCommandPaletteOpen }),
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
	requestNewTask: (projectId) =>
		set((state) => ({ newTaskRequest: { projectId, nonce: (state.newTaskRequest?.nonce ?? 0) + 1 } })),
	requestCreateProject: () => set((state) => ({ createProjectNonce: state.createProjectNonce + 1 })),
	requestNewShellTerminal: () => set((state) => ({ newShellTerminalNonce: state.newShellTerminalNonce + 1 })),
	setActiveShellTerminal: (activeShellTerminalHandleId) => set({ activeShellTerminalHandleId }),
}));

export function useResolvedTheme(): Theme {
	return useUiStore((state) => state.resolvedTheme);
}
