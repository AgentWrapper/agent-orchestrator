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
import { MuxClient, type MuxStatus, type SessionPatch } from "./mux";

const ACTIVE_PROJECT_KEY = "ao.activeProject";

type AppState = {
	config: ServerConfig | null;
	configured: boolean;
	projects: ProjectInfo[];
	sessions: DashboardSession[];
	orchestrators: OrchestratorLink[];
	orchestratorId: string | null;
	stats: DashboardStats;
	activeProjectId: string; // 'all' or a projectId
	connection: MuxStatus;
	loading: boolean;
	error: string | null;
	// actions
	reloadConfig: () => Promise<void>;
	refresh: () => Promise<void>;
	setActiveProject: (id: string) => void;
	spawn: (prompt?: string, projectId?: string) => Promise<void>;
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
	const [rawSessions, setRawSessions] = useState<DashboardSession[]>([]);
	const [patches, setPatches] = useState<Map<string, SessionPatch>>(new Map());
	const [orchestrators, setOrchestrators] = useState<OrchestratorLink[]>([]);
	const [orchestratorId, setOrchestratorId] = useState<string | null>(null);
	const [stats, setStats] = useState<DashboardStats>({});
	const [activeProjectId, setActiveProjectId] = useState<string>("all");
	const [connection, setConnection] = useState<MuxStatus>("closed");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const muxRef = useRef<MuxClient | null>(null);
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
			setLoading(false);
			return;
		}
		try {
			const [projs, sess] = await Promise.all([getProjects(c).catch(() => [] as ProjectInfo[]), getSessions(c, "all")]);
			setProjects(projs);
			setRawSessions(sess.sessions);
			setOrchestrators(sess.orchestrators);
			setOrchestratorId(sess.orchestratorId);
			setStats(sess.stats);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load");
		} finally {
			setLoading(false);
		}
	}, []);

	// (Re)connect the live mux socket whenever the config changes.
	useEffect(() => {
		muxRef.current?.disconnect();
		muxRef.current = null;
		setPatches(new Map());
		if (!config || !isConfigured(config)) {
			setLoading(false);
			return;
		}
		setLoading(true);
		fetchAll();
		const mux = new MuxClient(config, {
			onStatus: (s) => setConnection(s),
			onSessions: (snapshot) => {
				setPatches((prev) => {
					// Only allocate a new Map (→ re-render) when something actually changed.
					// The server re-sends an identical snapshot every 3s when idle.
					let changed = false;
					const next = new Map(prev);
					for (const p of snapshot) {
						const old = prev.get(p.id);
						if (
							!old ||
							old.status !== p.status ||
							old.activity !== p.activity ||
							old.attentionLevel !== p.attentionLevel ||
							old.lastActivityAt !== p.lastActivityAt
						) {
							next.set(p.id, p);
							changed = true;
						}
					}
					return changed ? next : prev;
				});
			},
		});
		muxRef.current = mux;
		mux.connect();
		mux.subscribeSessions();

		// REST safety-net poll (full fields the patch stream doesn't carry).
		const poll = setInterval(fetchAll, 12000);
		return () => {
			clearInterval(poll);
			mux.disconnect();
			muxRef.current = null;
		};
	}, [config, fetchAll]);

	// Merge live patches over the REST snapshot. A patch always carries the live
	// status/activity/attention, so it is authoritative for those fields (using
	// `??` would keep a stale `activity` when the agent went idle → activity:null).
	const sessions = useMemo(() => {
		if (patches.size === 0) return rawSessions;
		const known = new Set(rawSessions.map((s) => s.id));
		const merged = rawSessions.map((s) => {
			const p = patches.get(s.id);
			if (!p) return s;
			return {
				...s,
				status: p.status,
				activity: p.activity,
				attentionLevel: p.attentionLevel,
				lastActivityAt: p.lastActivityAt,
			};
		});
		// Sessions the server pushed over the mux but that aren't in the REST list
		// yet (e.g. just spawned by the orchestrator) — surface a minimal card now
		// instead of waiting up to 12s for the next poll to fill in full details.
		const fallbackProject = projects.length === 1 ? projects[0].id : "";
		const extras: DashboardSession[] = [];
		for (const [pid, p] of patches) {
			if (known.has(pid)) continue;
			extras.push({
				id: p.id,
				projectId: fallbackProject,
				status: p.status,
				attentionLevel: p.attentionLevel,
				activity: p.activity,
				branch: null,
				issueId: null,
				issueTitle: null,
				userPrompt: null,
				displayName: null,
				summary: null,
				createdAt: "",
				lastActivityAt: p.lastActivityAt,
				pr: null,
				prs: [],
			});
		}
		return extras.length ? [...merged, ...extras] : merged;
	}, [rawSessions, patches, projects]);

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
		async (prompt?: string, projectId?: string) => {
			const c = cfgRef.current;
			const proj = projectId ?? targetProject();
			if (!c || !proj) throw new Error("Pick a project first");
			await spawnSession(c, { projectId: proj, prompt });
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
	// object (→ re-render) on each render. Re-renders now track real state changes.
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
