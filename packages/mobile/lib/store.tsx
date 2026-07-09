import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
	collectPRs,
	getProjects,
	getSessions,
	killSession,
	launchOrchestrator as apiLaunchOrchestrator,
	mergePR as apiMergePR,
	restoreSession,
	sendMessage,
	spawnSession,
	type DashboardPR,
	type DashboardSession,
	type DashboardStats,
	type OrchestratorLink,
	type ProjectInfo,
} from "./api";
import { isConfigured, loadConfig, type ServerConfig } from "./config";

const ACTIVE_PROJECT_KEY = "ao.activeProject";
const POLL_INTERVAL_MS = 8000;

// Board-level connection state is derived from the REST poll. The session screen
// tracks its own terminal mux connection separately.
export type ConnStatus = "closed" | "connecting" | "open";

type AppState = {
	config: ServerConfig | null;
	configured: boolean;
	projects: ProjectInfo[];
	sessions: DashboardSession[];
	orchestrators: OrchestratorLink[];
	orchestratorId: string | null;
	stats: DashboardStats;
	activeProjectId: string; // 'all' or a projectId
	connection: ConnStatus;
	loading: boolean;
	error: string | null;
	// actions
	reloadConfig: () => Promise<void>;
	refresh: () => Promise<void>;
	setActiveProject: (id: string) => void;
	spawn: (prompt?: string, projectId?: string, harness?: string) => Promise<void>;
	launchConductor: (projectId: string, clean?: boolean) => Promise<OrchestratorLink>;
	merge: (pr: DashboardPR) => Promise<void>;
	kill: (id: string) => Promise<void>;
	restore: (id: string) => Promise<void>;
	send: (id: string, message: string) => Promise<void>;
};

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
	const ctx = useContext(AppContext);
	if (!ctx) throw new Error("useApp must be used within <AppProvider>");
	return ctx;
}

// Convenience selectors -------------------------------------------------------

export function useVisibleSessions(): DashboardSession[] {
	const { sessions, activeProjectId } = useApp();
	return useMemo(
		() => (activeProjectId === "all" ? sessions : sessions.filter((s) => s.projectId === activeProjectId)),
		[sessions, activeProjectId],
	);
}

export function usePRs() {
	const sessions = useVisibleSessions();
	return useMemo(() => collectPRs(sessions), [sessions]);
}

// Provider --------------------------------------------------------------------

export function AppProvider({ children }: { children: ReactNode }) {
	const [config, setConfig] = useState<ServerConfig | null>(null);
	const [projects, setProjects] = useState<ProjectInfo[]>([]);
	const [sessions, setSessions] = useState<DashboardSession[]>([]);
	const [orchestrators, setOrchestrators] = useState<OrchestratorLink[]>([]);
	const [orchestratorId, setOrchestratorId] = useState<string | null>(null);
	const [stats, setStats] = useState<DashboardStats>({});
	const [activeProjectId, setActiveProjectId] = useState<string>("all");
	const [connection, setConnection] = useState<ConnStatus>("closed");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const cfgRef = useRef<ServerConfig | null>(null);

	// Load persisted active project once.
	useEffect(() => {
		AsyncStorage.getItem(ACTIVE_PROJECT_KEY).then((v) => {
			if (v) setActiveProjectId(v);
		});
	}, []);

	const reloadConfig = useCallback(async () => {
		const c = await loadConfig();
		cfgRef.current = c;
		setConfig(c);
	}, []);

	useEffect(() => {
		reloadConfig();
	}, [reloadConfig]);

	const fetchAll = useCallback(async () => {
		const c = cfgRef.current;
		if (!c || !isConfigured(c)) {
			setConnection("closed");
			setLoading(false);
			return;
		}
		try {
			const [projs, sess] = await Promise.all([getProjects(c).catch(() => [] as ProjectInfo[]), getSessions(c, "all")]);
			setProjects(projs);
			setSessions(sess.sessions);
			setOrchestrators(sess.orchestrators);
			setOrchestratorId(sess.orchestratorId);
			setStats(sess.stats);
			setError(null);
			setConnection("open");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load");
			setConnection("closed");
		} finally {
			setLoading(false);
		}
	}, []);

	// (Re)start the REST poll whenever the config changes.
	useEffect(() => {
		if (!config || !isConfigured(config)) {
			setConnection("closed");
			setLoading(false);
			return;
		}
		setLoading(true);
		setConnection("connecting");
		fetchAll();
		const poll = setInterval(fetchAll, POLL_INTERVAL_MS);
		return () => clearInterval(poll);
	}, [config, fetchAll]);

	const setActiveProject = useCallback((id: string) => {
		setActiveProjectId(id);
		AsyncStorage.setItem(ACTIVE_PROJECT_KEY, id).catch(() => {});
	}, []);

	// Pick a sensible project for actions that need one (spawn / conductor).
	const targetProject = useCallback((): string | null => {
		if (activeProjectId !== "all") return activeProjectId;
		if (projects.length === 1) return projects[0].id;
		return null;
	}, [activeProjectId, projects]);

	const spawn = useCallback(
		async (prompt?: string, projectId?: string, harness?: string) => {
			const c = cfgRef.current;
			const proj = projectId ?? targetProject();
			if (!c || !proj) throw new Error("Pick a project first");
			await spawnSession(c, { projectId: proj, prompt, harness });
			await fetchAll();
		},
		[targetProject, fetchAll],
	);

	const launchConductor = useCallback(
		async (projectId: string, clean = false) => {
			const c = cfgRef.current!;
			const link = await apiLaunchOrchestrator(c, projectId, clean);
			await fetchAll();
			return link;
		},
		[fetchAll],
	);

	const merge = useCallback(
		async (pr: DashboardPR) => {
			await apiMergePR(cfgRef.current!, pr);
			await fetchAll();
		},
		[fetchAll],
	);

	const kill = useCallback(
		async (id: string) => {
			await killSession(cfgRef.current!, id);
			await fetchAll();
		},
		[fetchAll],
	);

	const restore = useCallback(
		async (id: string) => {
			await restoreSession(cfgRef.current!, id);
			await fetchAll();
		},
		[fetchAll],
	);

	const send = useCallback(async (id: string, message: string) => {
		await sendMessage(cfgRef.current!, id, message);
	}, []);

	// Memoized so the provider doesn't hand every useApp() consumer a brand-new
	// object (causing re-renders) on each render. Re-renders now track real state changes.
	const value = useMemo<AppState>(
		() => ({
			config,
			configured: !!config && isConfigured(config),
			projects,
			sessions,
			orchestrators,
			orchestratorId,
			stats,
			activeProjectId,
			connection,
			loading,
			error,
			reloadConfig,
			refresh: fetchAll,
			setActiveProject,
			spawn,
			launchConductor,
			merge,
			kill,
			restore,
			send,
		}),
		[
			config,
			projects,
			sessions,
			orchestrators,
			orchestratorId,
			stats,
			activeProjectId,
			connection,
			loading,
			error,
			reloadConfig,
			fetchAll,
			setActiveProject,
			spawn,
			launchConductor,
			merge,
			kill,
			restore,
			send,
		],
	);

	return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
