"use client";

import {
  ChevronRight,
  Cloud,
  FolderGit2,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  Play,
  Plus,
  Settings,
  Square,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type SVGProps,
} from "react";

import {
  CloudAPI,
  type AgentCredentialType,
  type CloudAgent,
  type CloudOrgInvitation,
  type CloudProject,
  type CloudRepository,
  type CloudSession,
  type CloudUserOrganization,
  type ProviderConnection,
} from "@/lib/cloud-api";
import {
  CLOUD_AGENTS,
  connectedAgentIDs,
  defaultConnectedAgent,
} from "@/lib/cloud-agent-connections";
import {
  removeWorkspaceSnapshots,
  warmWorkspaceSession,
} from "@/lib/cloud-workspace-cache";
import {
  clearCloudTerminalConnections,
  syncCloudTerminalConnections,
} from "@/lib/cloud-terminal-pool";
import { useAuth } from "../auth/AuthProvider";
import { PrismLogoGrid } from "../auth/PrismLogoGrid";
import { CloudInspector, type CloudInspectorTab } from "./CloudInspector";
import { CloudTerminal } from "./CloudTerminal";

type View = "board" | "session" | "settings";

interface SessionInspectorState {
  open: boolean;
  tab: CloudInspectorTab;
  previewAddress?: string;
}

const cloudSelectionKey = "ao-cloud-selection";
const cloudSidebarWidthKey = "ao-cloud-sidebar-width";
const cloudSidebarCollapsedKey = "ao-cloud-sidebar-collapsed";
const cloudProjectDisclosuresKey = "ao-cloud-project-disclosures";
const cloudInspectorKey = "ao-cloud-inspector";
const defaultSidebarWidth = 240;
const collapsedSidebarWidth = 52;
const minimumSidebarWidth = 200;
const maximumSidebarWidth = 420;
const button =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border px-2.5 text-sm text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45";
const primaryButton =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-[#4d8dff] px-3 text-sm text-white transition-colors hover:bg-[#397df0] disabled:cursor-not-allowed disabled:opacity-45";
const field =
  "h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-[#4d8dff]";

function OrchestratorIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...props}
    >
      <circle cx="12" cy="4" r="2" />
      <circle cx="5" cy="20" r="2" />
      <circle cx="12" cy="20" r="2" />
      <circle cx="19" cy="20" r="2" />
      <path d="M12 6v12M5 11h14M5 11v7M19 11v7" />
    </svg>
  );
}

function AgentAvatar({
  agent,
  className = "size-[18px]",
}: {
  agent: string;
  className?: string;
}) {
  if (["claude-code", "codex", "cursor"].includes(agent)) {
    return (
      <img
        src={`/agents/${agent}.svg`}
        alt=""
        aria-hidden="true"
        className={`${className} shrink-0 object-contain`}
        draggable={false}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${className} inline-flex shrink-0 items-center justify-center text-[11px] font-semibold uppercase text-[#9ba1aa]`}
    >
      {agent.charAt(0)}
    </span>
  );
}

function statusColor(session: CloudSession) {
  if (session.status === "terminated" || session.status === "exited")
    return "bg-white/25";
  if (
    session.status === "needs_input" ||
    session.status === "ci_failed" ||
    session.status === "changes_requested"
  )
    return "bg-[#e8c14a]";
  if (session.status === "working") return "bg-[#f59f4c]";
  if (session.status === "pr_open" || session.status === "review_pending")
    return "bg-[#5b8def]";
  return "bg-[#9ad97a]";
}

function sessionDisplayStatus(
  session: CloudSession,
  activeSessionIds: Set<string>,
) {
  return activeSessionIds.has(session.id) ? "working" : session.status;
}

export default function CloudAppPage() {
  const { session, status, login, logout } = useAuth();
  const api = useMemo(
    () => (session?.accessToken ? new CloudAPI(session.accessToken) : null),
    [session?.accessToken],
  );
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [sessions, setSessions] = useState<CloudSession[]>([]);
  const [organizations, setOrganizations] = useState<CloudUserOrganization[]>(
    [],
  );
  const [incomingInvitations, setIncomingInvitations] = useState<
    CloudOrgInvitation[]
  >([]);
  const [orgInvitations, setOrgInvitations] = useState<CloudOrgInvitation[]>([]);
  const [repositories, setRepositories] = useState<CloudRepository[]>([]);
  const [repositoriesLoading, setRepositoriesLoading] = useState(false);
  const [repositoriesError, setRepositoriesError] = useState<string | null>(
    null,
  );
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [sandboxProvider, setSandboxProvider] = useState<"daytona" | "fly">(
    "daytona",
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [view, setView] = useState<View>("board");
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [selectionRestored, setSelectionRestored] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(defaultSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarRevealed, setSidebarRevealed] = useState(false);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [inspectorWidth, setInspectorWidth] = useState(480);
  const [sessionInspectors, setSessionInspectors] = useState<
    Record<string, SessionInspectorState>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showSessionForm, setShowSessionForm] = useState(false);
  const [activeChatSessionIds, setActiveChatSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const selectedOrgIdRef = useRef<string | null>(null);
  const repositoriesLoaded = useRef(false);
  const repositoriesInFlight = useRef<Promise<void> | null>(null);
  const repositoriesGeneration = useRef(0);
  const selectedInspector = selectedSessionId
    ? sessionInspectors[selectedSessionId]
    : undefined;
  const inspectorOpen = selectedInspector?.open ?? false;
  const inspectorTab = selectedInspector?.tab ?? "terminal";
  const setInspectorOpen = useCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      if (!selectedSessionId) return;
      setSessionInspectors((current) => {
        const previous = current[selectedSessionId] ?? {
          open: false,
          tab: "terminal",
        };
        return {
          ...current,
          [selectedSessionId]: {
            ...previous,
            open: typeof next === "function" ? next(previous.open) : next,
          },
        };
      });
    },
    [selectedSessionId],
  );
  const setInspectorTab = useCallback(
    (tab: CloudInspectorTab) => {
      if (!selectedSessionId) return;
      setSessionInspectors((current) => ({
        ...current,
        [selectedSessionId]: {
          ...(current[selectedSessionId] ?? { open: false, tab: "terminal" }),
          tab,
        },
      }));
    },
    [selectedSessionId],
  );
  const setInspectorPreview = useCallback(
    (previewAddress: string) => {
      if (!selectedSessionId) return;
      setSessionInspectors((current) => ({
        ...current,
        [selectedSessionId]: {
          ...(current[selectedSessionId] ?? { open: false, tab: "terminal" }),
          previewAddress,
        },
      }));
    },
    [selectedSessionId],
  );

  useEffect(() => {
    try {
      const savedSelection = JSON.parse(
        window.localStorage.getItem(cloudSelectionKey) ?? "{}",
      ) as { projectId?: string; sessionId?: string };
      const savedWidthValue = window.localStorage.getItem(cloudSidebarWidthKey);
      const savedCollapsed =
        window.localStorage.getItem(cloudSidebarCollapsedKey) === "true";
      const savedProjectDisclosures = JSON.parse(
        window.localStorage.getItem(cloudProjectDisclosuresKey) ?? "[]",
      ) as unknown;
      const savedWidth =
        savedWidthValue === null ? Number.NaN : Number(savedWidthValue);
      const savedInspector = JSON.parse(
        window.localStorage.getItem(cloudInspectorKey) ?? "{}",
      ) as {
        open?: boolean;
        width?: number;
        tab?: CloudInspectorTab;
        sessions?: Record<string, Partial<SessionInspectorState>>;
      };
      setSelectedProjectId(null);
      setSelectedSessionId(null);
      setView("board");
      if (Number.isFinite(savedWidth)) {
        setSidebarWidth(
          Math.min(
            maximumSidebarWidth,
            Math.max(minimumSidebarWidth, savedWidth),
          ),
        );
      }
      setSidebarCollapsed(savedCollapsed);
      if (
        Array.isArray(savedProjectDisclosures) &&
        savedProjectDisclosures.every((value) => typeof value === "string")
      ) {
        setCollapsedProjectIds(new Set(savedProjectDisclosures));
      }
      if (typeof savedInspector.width === "number") {
        setInspectorWidth(Math.min(900, Math.max(320, savedInspector.width)));
      }
      const restoredInspectors: Record<string, SessionInspectorState> = {};
      for (const [sessionId, inspector] of Object.entries(
        savedInspector.sessions ?? {},
      )) {
        if (
          inspector &&
          inspector.tab &&
          ["changes", "browser", "terminal", "files"].includes(inspector.tab)
        ) {
          restoredInspectors[sessionId] = {
            open: inspector.open === true,
            tab: inspector.tab,
            previewAddress:
              typeof inspector.previewAddress === "string"
                ? inspector.previewAddress
                : undefined,
          };
        }
      }
      if (
        savedSelection.sessionId &&
        !restoredInspectors[savedSelection.sessionId]
      ) {
        restoredInspectors[savedSelection.sessionId] = {
          open: savedInspector.open === true,
          tab:
            savedInspector.tab &&
            ["changes", "browser", "terminal", "files"].includes(
              savedInspector.tab,
            )
              ? savedInspector.tab
              : "terminal",
        };
      }
      setSessionInspectors(restoredInspectors);
    } catch {
      window.localStorage.removeItem(cloudSelectionKey);
    } finally {
      setSelectionRestored(true);
    }
  }, []);

  useEffect(() => {
    if (!selectionRestored) return;
    window.localStorage.setItem(
      cloudSelectionKey,
      JSON.stringify({
        projectId: selectedProjectId,
        sessionId: selectedSessionId,
      }),
    );
  }, [selectedProjectId, selectedSessionId, selectionRestored]);

  useEffect(() => {
    if (!selectionRestored) return;
    window.localStorage.setItem(
      cloudInspectorKey,
      JSON.stringify({
        width: inspectorWidth,
        sessions: sessionInspectors,
      }),
    );
  }, [inspectorWidth, selectionRestored, sessionInspectors]);

  useEffect(() => {
    if (!selectionRestored) return;
    window.localStorage.setItem(
      cloudProjectDisclosuresKey,
      JSON.stringify([...collapsedProjectIds]),
    );
  }, [collapsedProjectIds, selectionRestored]);

  useEffect(() => {
    if (initialLoading) {
      setSidebarRevealed(false);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      setSidebarCollapsed(false);
      window.localStorage.setItem(cloudSidebarCollapsedKey, "false");
      setSidebarRevealed(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialLoading]);

  const connectedWorkspaceSessionIDs = useMemo(
    () =>
      sessions
        .filter((cloudSession) => cloudSession.runtimeConnected)
        .map((cloudSession) => cloudSession.id)
        .sort(),
    [sessions],
  );
  const connectedWorkspaceSessionKey = connectedWorkspaceSessionIDs.join(",");
  useEffect(() => {
    selectedOrgIdRef.current = selectedOrgId;
  }, [selectedOrgId]);
  useEffect(() => {
    if (!api || !selectedOrgId) return;
    const activeSessionIDs = new Set(connectedWorkspaceSessionIDs);
    removeWorkspaceSnapshots(activeSessionIDs);
    const warmAll = () => {
      for (const sessionID of connectedWorkspaceSessionIDs) {
        void warmWorkspaceSession(api, selectedOrgId, sessionID);
      }
    };
    warmAll();
    const refreshTimer = window.setInterval(warmAll, 3_000);
    return () => window.clearInterval(refreshTimer);
    // The stable key avoids restarting this timer on every status refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, connectedWorkspaceSessionKey, selectedOrgId]);
  useEffect(() => {
    if (!api || !selectedOrgId) {
      clearCloudTerminalConnections();
      return;
    }
    syncCloudTerminalConnections(api, selectedOrgId, connectedWorkspaceSessionIDs);
    // The stable key avoids reconnecting every terminal on status refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, connectedWorkspaceSessionKey, selectedOrgId]);
  useEffect(() => () => clearCloudTerminalConnections(), []);

  const loadRepositories = useCallback(() => {
    const orgId = selectedOrgIdRef.current;
    if (!api || !orgId || repositoriesLoaded.current) return Promise.resolve();
    if (repositoriesInFlight.current) return repositoriesInFlight.current;
    const generation = repositoriesGeneration.current;
    setRepositoriesLoading(true);
    setRepositoriesError(null);
    const request = api
      .repositories(orgId)
      .then((repositoryData) => {
        if (repositoriesGeneration.current !== generation) return;
        setRepositories(repositoryData.repositories);
        repositoriesLoaded.current = true;
      })
      .catch((repositoryError: unknown) => {
        if (repositoriesGeneration.current !== generation) return;
        setRepositoriesError(
          repositoryError instanceof Error
            ? repositoryError.message
            : "Could not load GitHub repositories.",
        );
      })
      .finally(() => {
        if (repositoriesGeneration.current !== generation) return;
        repositoriesInFlight.current = null;
        setRepositoriesLoading(false);
      });
    repositoriesInFlight.current = request;
    return request;
  }, [api, selectedOrgId]);

  useEffect(() => {
    repositoriesGeneration.current += 1;
    repositoriesLoaded.current = false;
    repositoriesInFlight.current = null;
    setRepositories([]);
    setRepositoriesError(null);
    setRepositoriesLoading(false);
  }, [api, selectedOrgId]);

  useEffect(() => {
    if (showProjectForm) void loadRepositories();
  }, [loadRepositories, showProjectForm]);

  const refresh = useCallback(() => {
    if (!api) return Promise.resolve();
    if (refreshInFlight.current) return refreshInFlight.current;
    const request = (async () => {
      try {
        const runtimeData = await api.me();
        const nextOrganizations = runtimeData.organizations ?? [];
        setOrganizations(nextOrganizations);
        const nextOrgId =
          selectedOrgIdRef.current &&
          nextOrganizations.some(
            ({ organization }) => organization.id === selectedOrgIdRef.current,
          )
            ? selectedOrgIdRef.current
            : (nextOrganizations[0]?.organization.id ?? null);
        if (selectedOrgIdRef.current !== nextOrgId) {
          selectedOrgIdRef.current = nextOrgId;
          setSelectedOrgId(nextOrgId);
        }
        if (!nextOrgId) {
          setProjects([]);
          setSessions([]);
          setConnections([]);
          setIncomingInvitations([]);
          setOrgInvitations([]);
          setError(null);
          return;
        }
        const selectedOrgMembership = nextOrganizations.find(
          ({ organization }) => organization.id === nextOrgId,
        )?.membership;
        const canLoadOrgInvitations =
          selectedOrgMembership?.role === "owner" ||
          selectedOrgMembership?.role === "admin";
        const [
          projectData,
          sessionData,
          connectionData,
          incomingInvitationData,
          orgInvitationData,
        ] = await Promise.all([
          api.projects(nextOrgId),
          api.sessions(nextOrgId),
          api.providerConnections(nextOrgId),
          api.invitations(),
          canLoadOrgInvitations
            ? api.orgInvitations(nextOrgId)
            : Promise.resolve({ invitations: [] }),
        ]);
        setProjects(projectData.projects);
        setSessions(sessionData.sessions);
        const authoritativeActive = new Set(
          sessionData.sessions
            .filter(
              (cloudSession) =>
                cloudSession.status === "working" ||
                cloudSession.activeTurn !== undefined,
            )
            .map(({ id }) => id),
        );
        setActiveChatSessionIds(authoritativeActive);
        setConnections(connectionData.providerConnections);
        setIncomingInvitations(incomingInvitationData.invitations);
        setOrgInvitations(orgInvitationData.invitations);
        setSandboxProvider(runtimeData.sandboxProvider);
        setError(null);
      } catch (refreshError) {
        setError(
          refreshError instanceof Error
            ? refreshError.message
            : "Could not load AO Cloud.",
        );
      } finally {
        refreshInFlight.current = null;
        setInitialLoading(false);
      }
    })();
    refreshInFlight.current = request;
    return request;
  }, [api]);

  useEffect(() => {
    if (!api) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    const refreshNow = () => void refresh();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshNow();
    };
    window.addEventListener("focus", refreshNow);
    window.addEventListener("online", refreshNow);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshNow);
      window.removeEventListener("online", refreshNow);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [api, refresh]);

  const selectedProject = projects.find(({ id }) => id === selectedProjectId);
  const selectedSession = sessions.find(({ id }) => id === selectedSessionId);
  const selectedOrg = organizations.find(
    ({ organization }) => organization.id === selectedOrgId,
  );
  const selectedOrgRole = selectedOrg?.membership.role ?? "viewer";
  const canEditOrg =
    selectedOrgRole === "owner" ||
    selectedOrgRole === "admin" ||
    selectedOrgRole === "member";
  const terminalRuntimeAvailable =
    selectedSession?.capabilities?.includes("runtime.pty.v1") === true;
  const daytonaConnections = connections.filter(
    ({ provider }) => provider === "daytona",
  );
  const defaultAgent = defaultConnectedAgent(connections);
  const selectedProjectOrchestrator = sessions.find(
    ({ projectId, kind, isTerminated }) =>
      projectId === selectedProjectId &&
      kind === "orchestrator" &&
      !isTerminated,
  );
  const workerSessions = sessions.filter(({ kind }) => kind === "worker");
  const visibleSessions = selectedProjectId
    ? workerSessions.filter(({ projectId }) => projectId === selectedProjectId)
    : workerSessions;

  useEffect(() => {
    if (initialLoading || !selectedSessionId) return;
    const restoredSession = sessions.find(({ id }) => id === selectedSessionId);
    if (!restoredSession) {
      setSelectedSessionId(null);
      setView("board");
      return;
    }
    if (selectedProjectId !== restoredSession.projectId) {
      setSelectedProjectId(restoredSession.projectId);
    }
  }, [initialLoading, selectedProjectId, selectedSessionId, sessions]);

  useEffect(() => {
    if (
      initialLoading ||
      !selectedProjectId ||
      projects.some(({ id }) => id === selectedProjectId)
    ) {
      return;
    }
    setSelectedProjectId(null);
    setSelectedSessionId(null);
    setView("board");
  }, [initialLoading, projects, selectedProjectId]);

  const run = async (operation: () => Promise<unknown>) => {
    setLoading(true);
    try {
      await operation();
      await refresh();
      setError(null);
      return true;
    } catch (operationError) {
      setError(
        operationError instanceof Error
          ? operationError.message
          : "Cloud operation failed.",
      );
      return false;
    } finally {
      setLoading(false);
    }
  };

  const createSessionAndOpen = async (
    operation: () => Promise<{ session: CloudSession }>,
  ) => {
    setLoading(true);
    try {
      const result = await operation();
      await refresh();
      setSelectedProjectId(result.session.projectId);
      setSelectedSessionId(result.session.id);
      setView("session");
      setError(null);
      return true;
    } catch (operationError) {
      setError(
        operationError instanceof Error
          ? operationError.message
          : "Could not create the cloud session.",
      );
      return false;
    } finally {
      setLoading(false);
    }
  };

  const startOrchestrator = () => {
    if (!api || !selectedOrgId || !selectedProjectId || !defaultAgent || !canEditOrg) return;
    void createSessionAndOpen(() =>
      api.createSession(
        selectedOrgId,
        {
          projectId: selectedProjectId,
          kind: "orchestrator",
          harness: defaultAgent,
          displayName: "Orchestrator",
          prompt: "",
          providerConnectionId: daytonaConnections[0]?.id,
        },
        crypto.randomUUID(),
      ),
    );
  };

  const createProjectAndPrewarmOrchestrator = async (input: {
    displayName: string;
    repositoryUrl: string;
    defaultBranch: string;
  }) => {
    if (!api || !selectedOrgId || !defaultAgent || !canEditOrg) {
      setError("Connect a coding agent before creating a cloud project.");
      setView("settings");
      return;
    }
    setLoading(true);
    try {
      const { project } = await api.createProject(selectedOrgId, input);
      let orchestrator: CloudSession | null = null;
      if (defaultAgent) {
        const result = await api.createSession(
          selectedOrgId,
          {
            projectId: project.id,
            kind: "orchestrator",
            harness: defaultAgent,
            displayName: "Orchestrator",
            prompt: "",
            providerConnectionId: daytonaConnections[0]?.id,
          },
          crypto.randomUUID(),
        );
        orchestrator = result.session;
      }
      await refresh();
      setSelectedProjectId(project.id);
      setSelectedSessionId(orchestrator?.id ?? null);
      setView(orchestrator ? "session" : "board");
      setShowProjectForm(false);
      setError(null);
    } catch (operationError) {
      setError(
        operationError instanceof Error
          ? operationError.message
          : "Could not create and start the project orchestrator.",
      );
    } finally {
      setLoading(false);
    }
  };

  const deleteSelectedWorkerMachine = async () => {
    if (!api || !selectedOrgId || !selectedSession || selectedSession.kind !== "worker") return;
    const confirmed = window.confirm(
      `Delete ${selectedSession.displayName}'s cloud session, machine, and workspace volume?\n\nThis removes the worker from the board after the control plane tears down its sandbox.`,
    );
    if (!confirmed) return;
    const deleted = await run(() =>
      api.setDesiredState(selectedOrgId, selectedSession.id, "deleted"),
    );
    if (!deleted) return;
    setActiveChatSessionIds((current) => {
      const next = new Set(current);
      next.delete(selectedSession.id);
      return next;
    });
    setSelectedSessionId(null);
    setView("board");
  };

  const toggleSidebar = () => {
    setSidebarCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(cloudSidebarCollapsedKey, String(next));
      return next;
    });
  };

  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let nextWidth = startWidth;
    const availableMaximum = Math.max(
      minimumSidebarWidth,
      Math.min(maximumSidebarWidth, window.innerWidth - 320),
    );
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const move = (moveEvent: PointerEvent) => {
      nextWidth = Math.min(
        availableMaximum,
        Math.max(minimumSidebarWidth, startWidth + moveEvent.clientX - startX),
      );
      setSidebarWidth(nextWidth);
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.localStorage.setItem(cloudSidebarWidthKey, String(nextWidth));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };

  if (status === "loading") {
    return (
      <main className="grid min-h-dvh place-items-center bg-[#0a0b0d] text-white/60">
        <LoaderCircle className="size-5 animate-spin" aria-label="Loading" />
      </main>
    );
  }

  if (!api) {
    return (
      <main className="grid min-h-dvh place-items-center bg-[#0a0b0d] px-4">
        <section className="w-full max-w-sm border border-white/10 bg-[#15171b] p-6 text-center">
          <Cloud className="mx-auto size-5 text-[#4d8dff]" />
          <h1 className="mt-4 text-lg font-medium text-[#f4f5f7]">AO Cloud</h1>
          <p className="mt-2 text-sm leading-6 text-[#9ba1aa]">
            Sign in to run orchestrators and workers in isolated cloud
            environments.
          </p>
          <button
            className={`${primaryButton} mt-5`}
            onClick={() => void login()}
          >
            Continue with email
          </button>
        </section>
      </main>
    );
  }

  return (
    <main
      className="ao-cloud-app fixed inset-0 z-[60] h-dvh overflow-hidden bg-[#0a0b0d] font-[-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif] text-[#f4f5f7]"
      aria-busy={loading || initialLoading}
    >
      <div
        className="grid h-full transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none"
        style={{
          gridTemplateColumns: `${
            sidebarRevealed
              ? sidebarCollapsed
                ? collapsedSidebarWidth
                : sidebarWidth
              : 0
          }px minmax(0, 1fr)`,
        }}
      >
        <aside
          className="relative flex min-h-0 flex-col overflow-hidden bg-[#17181c]"
          aria-hidden={!sidebarRevealed}
          inert={!sidebarRevealed}
        >
          <div
            className={`flex h-11 shrink-0 items-center ${
              sidebarCollapsed ? "justify-center px-1.5" : "gap-2 px-3"
            }`}
          >
            {!sidebarCollapsed ? (
              <>
                <img
                  src="/ao-logo.svg"
                  alt=""
                  aria-hidden="true"
                  className="size-[22px] shrink-0 rounded-md object-cover"
                />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-[-0.015em]">
                  Agent Orchestrator
                </span>
                {sidebarWidth >= 280 ? (
                  <span className="rounded-full border border-white/10 px-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-white/40">
                    Cloud
                  </span>
                ) : null}
              </>
            ) : null}
            <button
              type="button"
              className={`grid size-7 shrink-0 place-items-center rounded-md text-[#646a73] transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d8dff]/70 ${
                sidebarCollapsed ? "" : "ml-auto"
              }`}
              onClick={toggleSidebar}
              aria-label={
                sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
              }
              aria-expanded={!sidebarCollapsed}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {sidebarCollapsed ? (
                <PanelLeftOpen className="size-[15px]" />
              ) : (
                <PanelLeftClose className="size-[15px]" />
              )}
            </button>
          </div>
          {!sidebarCollapsed ? (
            <div className="mx-1.5 mb-2 rounded-lg border border-white/[0.06] bg-[#111317] p-2">
              <label className="block font-mono text-[9px] uppercase tracking-[0.12em] text-white/30">
                Workspace
              </label>
              <select
                className="mt-1 h-8 w-full rounded-md border border-white/[0.08] bg-[#171a1f] px-2 text-sm text-white outline-none focus:border-[#4d8dff]"
                value={selectedOrgId ?? ""}
                onChange={(event) => {
                  const nextOrgId = event.target.value || null;
                  selectedOrgIdRef.current = nextOrgId;
                  setSelectedOrgId(nextOrgId);
                  setSelectedProjectId(null);
                  setSelectedSessionId(null);
                  setView("board");
                }}
              >
                {organizations.map(({ organization, membership }) => (
                  <option key={organization.id} value={organization.id}>
                    {organization.displayName} · {membership.role}
                  </option>
                ))}
              </select>
              <div className="mt-1 truncate text-[11px] text-white/35">
                {session?.user.email ?? "Signed in"}
              </div>
            </div>
          ) : null}
          <button
            className={`mx-1.5 flex h-8 shrink-0 items-center rounded-lg text-left text-sm ${
              sidebarCollapsed ? "justify-center px-0" : "gap-2 px-2"
            } ${
              !selectedProjectId && view === "board"
                ? "bg-white/[0.07] text-white"
                : "text-[#9ba1aa] hover:bg-white/[0.04] hover:text-white"
            }`}
            onClick={() => {
              setSelectedProjectId(null);
              setSelectedSessionId(null);
              setView("board");
            }}
            aria-label="Board"
            title={sidebarCollapsed ? "Board" : undefined}
          >
            <LayoutDashboard className="size-[15px] shrink-0" />
            {!sidebarCollapsed ? "Board" : null}
          </button>
          <div
            className={`mt-4 flex items-center ${
              sidebarCollapsed
                ? "justify-center px-1.5"
                : "justify-between px-3"
            }`}
          >
            {!sidebarCollapsed ? (
              <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.05em] text-[#646a73]">
                Projects
              </span>
            ) : null}
            <button
              className="grid size-5 place-items-center rounded-md text-[#646a73] transition-colors hover:bg-white/[0.04] hover:text-white"
              onClick={() => {
                if (defaultAgent && canEditOrg) setShowProjectForm(true);
                else setView("settings");
              }}
              aria-label="Add cloud project"
              title={
                sidebarCollapsed
                  ? defaultAgent && canEditOrg
                    ? "Add project"
                    : "Connect an agent and use an editable org"
                  : defaultAgent && canEditOrg
                    ? "Add project"
                    : "Connect an agent and use an editable org"
              }
            >
              <Plus className="size-[15px]" />
            </button>
          </div>
          <div className="mt-1 min-h-0 flex-1 overflow-auto px-1.5">
            {projects.map((project) => {
              const projectSessions = sessions.filter(
                ({ projectId }) => projectId === project.id,
              );
              const expanded = !collapsedProjectIds.has(project.id);
              const projectActive =
                selectedProjectId === project.id && view === "board";
              return (
                <div key={project.id} className="mb-1">
                  <button
                    className={`flex h-8 w-full items-center rounded-lg text-left text-sm ${
                      sidebarCollapsed ? "justify-center px-0" : "gap-2 px-2"
                    } ${
                      projectActive
                        ? "bg-white/[0.07] text-white"
                        : "text-[#9ba1aa] hover:bg-white/[0.04] hover:text-white"
                    }`}
                    onClick={() => {
                      if (!expanded) {
                        setCollapsedProjectIds((current) => {
                          const next = new Set(current);
                          next.delete(project.id);
                          return next;
                        });
                      } else if (projectActive) {
                        setCollapsedProjectIds((current) => {
                          const next = new Set(current);
                          next.add(project.id);
                          return next;
                        });
                        return;
                      }
                      setSelectedProjectId(project.id);
                      setSelectedSessionId(null);
                      setView("board");
                    }}
                    aria-label={project.displayName}
                    aria-expanded={expanded}
                    title={sidebarCollapsed ? project.displayName : undefined}
                  >
                    {!sidebarCollapsed ? (
                      <>
                        <ChevronRight
                          className={`size-3.5 shrink-0 text-[#646a73] transition-transform duration-150 motion-reduce:transition-none ${
                            expanded ? "rotate-90" : ""
                          }`}
                          strokeWidth={2.5}
                          aria-hidden="true"
                        />
                        <FolderGit2 className="size-[15px] shrink-0" />
                      </>
                    ) : (
                      <FolderGit2 className="size-[15px] shrink-0" />
                    )}
                    {!sidebarCollapsed ? (
                      <span className="truncate">{project.displayName}</span>
                    ) : null}
                  </button>
                  {expanded ? (
                    <div
                      className={
                        sidebarCollapsed
                          ? ""
                          : "ml-[15px] border-l border-white/[0.06] pl-1.5"
                      }
                    >
                      {projectSessions.map((cloudSession) => (
                        <button
                          key={cloudSession.id}
                          className={`flex h-7 w-full items-center rounded-lg text-left text-[12px] ${
                            sidebarCollapsed
                              ? "justify-center px-0"
                              : "gap-2 border-l-2 px-2"
                          } ${
                            selectedSessionId === cloudSession.id &&
                            view === "session"
                              ? "border-[#4d8dff] bg-white/[0.07] text-white"
                              : "border-transparent text-[#9ba1aa] hover:bg-white/[0.04] hover:text-white"
                          }`}
                          onClick={() => {
                            setSelectedProjectId(project.id);
                            setSelectedSessionId(cloudSession.id);
                            setView("session");
                          }}
                          aria-label={cloudSession.displayName}
                          title={
                            sidebarCollapsed
                              ? cloudSession.displayName
                              : undefined
                          }
                        >
                          {cloudSession.kind === "orchestrator" ? (
                            <OrchestratorIcon className="size-[14px] shrink-0" />
                          ) : (
                            <AgentAvatar
                              agent={cloudSession.harness}
                              className="size-[14px]"
                            />
                          )}
                          {!sidebarCollapsed ? (
                            <span className="truncate">
                              {cloudSession.displayName}
                            </span>
                          ) : null}
                          {!sidebarCollapsed &&
                          activeChatSessionIds.has(cloudSession.id) ? (
                            <LoaderCircle
                              className="ml-auto size-3.5 shrink-0 animate-spin text-[#4d8dff] motion-reduce:animate-none"
                              aria-label="Working"
                            />
                          ) : !sidebarCollapsed ? (
                            <span
                              className={`ml-auto size-1.5 shrink-0 rounded-full ${statusColor(
                                cloudSession,
                              )}`}
                              aria-hidden="true"
                            />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="min-h-[105px] shrink-0 border-t border-white/[0.06] p-1.5">
            <button
              className={`flex h-8 w-full items-center rounded-lg text-sm text-[#9ba1aa] hover:bg-white/[0.04] hover:text-white ${
                sidebarCollapsed ? "justify-center px-0" : "gap-2 px-2"
              }`}
              onClick={() => setView("settings")}
              aria-label="Settings"
              title={sidebarCollapsed ? "Settings" : undefined}
            >
              <Settings className="size-[15px] shrink-0" />
              {!sidebarCollapsed ? "Settings" : null}
            </button>
            <button
              className={`flex h-8 w-full items-center rounded-lg text-[12px] text-[#646a73] hover:bg-white/[0.04] hover:text-white ${
                sidebarCollapsed ? "justify-center px-0" : "gap-2 px-2"
              }`}
              onClick={() => void logout()}
              aria-label="Log out"
              title={
                sidebarCollapsed
                  ? `Log out ${session?.user.email ?? ""}`.trim()
                  : undefined
              }
            >
              <LogOut className="size-[15px] shrink-0" />
              {!sidebarCollapsed ? (
                <span className="truncate">
                  {session?.user.email ?? "Logout"}
                </span>
              ) : null}
            </button>
          </div>
          {!sidebarCollapsed ? (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              tabIndex={0}
              className="absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize bg-transparent transition-colors duration-150 hover:bg-[#4d8dff]/60 focus-visible:bg-[#4d8dff] focus-visible:outline-none motion-reduce:transition-none"
              onPointerDown={beginSidebarResize}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                  return;
                event.preventDefault();
                const direction = event.key === "ArrowLeft" ? -1 : 1;
                const nextWidth = Math.min(
                  maximumSidebarWidth,
                  Math.max(minimumSidebarWidth, sidebarWidth + direction * 16),
                );
                setSidebarWidth(nextWidth);
                window.localStorage.setItem(
                  cloudSidebarWidthKey,
                  String(nextWidth),
                );
              }}
              onDoubleClick={() => {
                setSidebarWidth(defaultSidebarWidth);
                window.localStorage.setItem(
                  cloudSidebarWidthKey,
                  String(defaultSidebarWidth),
                );
              }}
            />
          ) : null}
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col border-l border-white/[0.06] bg-[#0a0b0d]">
          {!(view === "board" && !selectedProjectId) ? (
          <header className="relative flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-4">
            <div className="min-w-0">
              <h1 className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium">
                {view === "settings"
                  ? "Cloud settings"
                  : selectedSession
                    ? `${selectedProject?.displayName ?? "Project"} / ${selectedSession.displayName}`
                    : (selectedProject?.displayName ?? "Board")}
              </h1>
            </div>
            <div className="ml-auto flex max-w-full shrink-0 items-center gap-2 overflow-x-auto">
              {view === "session" && selectedSession ? (
                <>
                  <button
                    className={button}
                    disabled={loading || !canEditOrg}
                    onClick={() => setShowSessionForm(true)}
                    aria-label="New task"
                  >
                    <Plus className="size-3.5" />
                    <span className="hidden xl:inline">New task</span>
                  </button>
                  <button
                    className={primaryButton}
                    onClick={() => {
                      setSelectedSessionId(null);
                      setView("board");
                    }}
                    aria-label="Open Kanban board"
                  >
                    <LayoutDashboard className="size-3.5" />
                    <span className="hidden xl:inline">Kanban</span>
                  </button>
                  <span className="mr-1 inline-flex h-7 items-center gap-1.5 rounded-md border border-white/10 px-2 font-mono text-[10px] uppercase tracking-[0.05em] text-[#9ba1aa]">
                    {activeChatSessionIds.has(selectedSession.id) ? (
                      <LoaderCircle
                        className="size-3.5 animate-spin text-[#4d8dff] motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : (
                      <span
                        className={`size-1.5 rounded-full ${statusColor(
                          selectedSession,
                        )}`}
                        aria-hidden="true"
                      />
                    )}
                    {activeChatSessionIds.has(selectedSession.id)
                      ? "working"
                      : selectedSession.status.replaceAll("_", " ")}
                  </span>
                  <button
                    className={button}
                    onClick={() => setInspectorOpen((current) => !current)}
                    aria-label={
                      inspectorOpen
                        ? "Close session inspector"
                        : "Open session inspector"
                    }
                    aria-expanded={inspectorOpen}
                    title={
                      inspectorOpen
                        ? "Close workspace tools"
                        : "Open workspace tools"
                    }
                  >
                    <PanelRightOpen className="size-3.5" />
                  </button>
                  {selectedSession.kind === "worker" ? (
                    <button
                      className={button}
                      disabled={loading}
                      onClick={() => void deleteSelectedWorkerMachine()}
                      aria-label={`Delete ${selectedSession.displayName} machine`}
                      title="Delete worker machine"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  ) : null}
                </>
              ) : view === "board" && selectedProjectId ? (
                <>
                  <button
                    className={primaryButton}
                    onClick={() => setShowSessionForm(true)}
                    disabled={loading || !canEditOrg}
                  >
                    <Plus className="size-3.5" />
                    New task
                  </button>
                  <button
                    className={button}
                    disabled={
                      loading ||
                      !canEditOrg ||
                      (!selectedProjectOrchestrator && !defaultAgent)
                    }
                    onClick={() => {
                      if (selectedProjectOrchestrator) {
                        setSelectedSessionId(selectedProjectOrchestrator.id);
                        setView("session");
                      } else {
                        startOrchestrator();
                      }
                    }}
                  >
                    <OrchestratorIcon className="size-3.5" />
                    Orchestrator
                  </button>
                </>
              ) : null}
            </div>
            {loading ? (
              <div className="absolute inset-x-0 bottom-0 h-px overflow-hidden bg-[#4d8dff]/15">
                <div className="h-full w-1/3 animate-[cloud-progress_900ms_ease-in-out_infinite] bg-[#4d8dff] motion-reduce:w-full motion-reduce:animate-none" />
              </div>
            ) : null}
          </header>
          ) : null}

          {error && (
            <div
              role="alert"
              className="border-b border-[#ef6b6b]/30 bg-[#ef6b6b]/10 px-4 py-2 text-xs text-[#ef9b9b]"
            >
              {error}
            </div>
          )}

          <div className="min-h-0 flex-1">
            {initialLoading ? (
              <div className="grid h-full place-items-center bg-[#08090b]">
                <PrismLogoGrid variant="loader" />
              </div>
            ) : view === "settings" ? (
              <CloudSettings
                api={api}
                selectedOrg={selectedOrg}
                incomingInvitations={incomingInvitations}
                orgInvitations={orgInvitations}
                connections={connections}
                sandboxProvider={sandboxProvider}
                run={run}
                loading={loading}
              />
            ) : view === "session" && selectedSession && selectedOrgId ? (
              terminalRuntimeAvailable ? (
                <div className="flex h-full min-h-0 min-w-0">
                  <div className="min-h-0 min-w-0 flex-1">
                    <CloudTerminal
                      api={api}
                      orgId={selectedOrgId}
                      sessionId={selectedSession.id}
                      layoutKey={inspectorOpen ? "inspector-open" : "inspector-closed"}
                    />
                  </div>
                  <CloudInspector
                    key={selectedSession.id}
                    api={api}
                    orgId={selectedOrgId}
                    sessionId={selectedSession.id}
                    runtimeConnected={selectedSession.runtimeConnected}
                    previewAddress={selectedInspector?.previewAddress}
                    tab={inspectorTab}
                    open={inspectorOpen}
                    width={inspectorWidth}
                    onTabChange={setInspectorTab}
                    onPreviewAddressChange={setInspectorPreview}
                    onWidthChange={setInspectorWidth}
                    onClose={() => setInspectorOpen(false)}
                  />
                </div>
              ) : (
                <CloudRuntimeConnecting session={selectedSession} />
              )
            ) : (
              <SessionBoard
                sessions={visibleSessions}
                projects={projects}
                activeSessionIds={activeChatSessionIds}
                orchestrator={selectedProjectOrchestrator}
                onSelect={(cloudSession) => {
                  setSelectedProjectId(cloudSession.projectId);
                  setSelectedSessionId(cloudSession.id);
                  setView("session");
                }}
                onCreateOrchestrator={
                  selectedProjectId &&
                  defaultAgent &&
                  canEditOrg &&
                  !selectedProjectOrchestrator
                    ? startOrchestrator
                    : undefined
                }
                agentAvailable={Boolean(defaultAgent)}
                loading={loading}
                onOpenSettings={() => setView("settings")}
              />
            )}
          </div>
        </section>
      </div>

      {showProjectForm && (
        <ProjectForm
          repositories={repositories}
          repositoriesLoading={repositoriesLoading}
          repositoriesError={repositoriesError}
          loading={loading}
          onClose={() => setShowProjectForm(false)}
          onSubmit={createProjectAndPrewarmOrchestrator}
        />
      )}
      {showSessionForm && selectedOrgId && selectedProjectId && (
        <SessionForm
          projectId={selectedProjectId}
          providerConnectionId={daytonaConnections[0]?.id}
          connections={connections}
          loading={loading}
          onOpenSettings={() => {
            setShowSessionForm(false);
            setView("settings");
          }}
          onClose={() => setShowSessionForm(false)}
          onSubmit={async (input) => {
            const created = await createSessionAndOpen(() =>
              api.createSession(selectedOrgId, input, crypto.randomUUID()),
            );
            if (created) setShowSessionForm(false);
          }}
        />
      )}
    </main>
  );
}

function CloudRuntimeConnecting({ session }: { session: CloudSession }) {
  const role = session.kind === "orchestrator" ? "orchestrator" : "worker";
  return (
    <div
      className="grid h-full min-h-0 place-items-center bg-[#0a0b0d] px-6"
      role="status"
      aria-live="polite"
    >
      <div className="w-full max-w-md">
        <div className="flex items-center gap-4">
          <div className="relative grid size-12 shrink-0 place-items-center">
            <span className="absolute inset-0 animate-ping rounded-full border border-[#4d8dff]/25 [animation-duration:2.4s] motion-reduce:animate-none" />
            <span className="absolute inset-1.5 rounded-full border border-white/[0.08]" />
            <AgentAvatar agent={session.harness} className="relative size-6" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-[#f4f5f7]">
              Connecting {role}
            </h2>
            <p className="mt-1 truncate text-xs text-[#646a73]">
              {session.displayName} · {session.branch}
            </p>
          </div>
          <LoaderCircle className="ml-auto size-4 shrink-0 animate-spin text-[#4d8dff] motion-reduce:animate-none" />
        </div>

        <div className="mt-7 grid grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-2 text-[11px] text-[#646a73]">
          <span className="text-[#9ba1aa]">Sandbox</span>
          <span className="h-px overflow-hidden bg-white/[0.08]">
            <span className="block h-full w-1/2 animate-[cloud-progress_1.5s_ease-in-out_infinite] bg-[#4d8dff]/60 motion-reduce:animate-none" />
          </span>
          <span className="text-[#9ba1aa]">Runtime</span>
          <span className="h-px overflow-hidden bg-white/[0.08]">
            <span className="block h-full w-1/2 animate-[cloud-progress_1.5s_ease-in-out_300ms_infinite] bg-[#4d8dff]/60 motion-reduce:animate-none" />
          </span>
          <span>Live chat</span>
        </div>
        <p className="mt-5 text-xs leading-5 text-[#646a73]">
          AO will open the native chat as soon as the agent runtime is ready.
          The task keeps starting even if you leave this view.
        </p>
      </div>
    </div>
  );
}

function RepositorySetupIndicator() {
  const stages = [
    { label: "Secure VM", icon: Cloud },
    { label: "Repository", icon: FolderGit2 },
    { label: "Orchestrator", icon: OrchestratorIcon },
  ];
  return (
    <div className="pointer-events-none absolute inset-x-0 top-16 z-20 flex justify-center px-4">
      <div
        className="w-full max-w-md rounded-xl border border-white/10 bg-[#111317]/95 p-4 shadow-[0_18px_60px_rgba(0,0,0,0.38)] backdrop-blur"
        role="status"
        aria-label="Preparing repository on the cloud VM"
      >
        <div className="flex items-center gap-2">
          <LoaderCircle
            className="size-3.5 animate-spin text-[#4d8dff] motion-reduce:animate-none"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-[#f4f5f7]">
            Preparing the orchestrator workspace
          </p>
        </div>
        <p className="mt-1.5 text-xs leading-5 text-[#646a73]">
          Provisioning an isolated VM, cloning the repository, and starting the
          agent runtime.
        </p>
        <div className="relative mt-4 grid grid-cols-3">
          <span className="absolute left-[16.67%] right-[16.67%] top-3 h-px overflow-hidden bg-white/10">
            <span className="block h-full w-1/3 animate-[cloud-progress_1.8s_ease-in-out_infinite] bg-[#4d8dff]/80 motion-reduce:animate-none" />
          </span>
          {stages.map(({ label, icon: Icon }, index) => (
            <div
              key={label}
              className="relative z-10 flex flex-col items-center gap-1.5"
            >
              <span
                className="cloud-repository-stage grid size-6 place-items-center rounded-md border border-white/10 bg-[#17191e] text-[#8eb6ff] motion-reduce:animate-none"
                style={{ animationDelay: `${index * 600}ms` }}
              >
                <Icon className="size-3.5" aria-hidden="true" />
              </span>
              <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-[#646a73]">
                {label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SessionBoard({
  sessions,
  projects,
  activeSessionIds,
  orchestrator,
  onSelect,
  onCreateOrchestrator,
  agentAvailable,
  loading,
  onOpenSettings,
}: {
  sessions: CloudSession[];
  projects: CloudProject[];
  activeSessionIds: Set<string>;
  orchestrator?: CloudSession;
  onSelect: (session: CloudSession) => void;
  onCreateOrchestrator?: () => void;
  agentAvailable: boolean;
  loading: boolean;
  onOpenSettings: () => void;
}) {
  const columns = [
    [
      "Working",
      "#36c2b4",
      sessions.filter((item) =>
        ["working", "idle", "exited"].includes(
          sessionDisplayStatus(item, activeSessionIds),
        ),
      ),
    ],
    [
      "Needs you",
      "#f2b84b",
      sessions.filter((item) =>
        ["needs_input", "ci_failed", "changes_requested"].includes(
          sessionDisplayStatus(item, activeSessionIds),
        ),
      ),
    ],
    [
      "In review",
      "#5b8def",
      sessions.filter((item) =>
        ["pr_open", "review_pending"].includes(
          sessionDisplayStatus(item, activeSessionIds),
        ),
      ),
    ],
    [
      "Ready to merge",
      "#9ad97a",
      sessions.filter((item) =>
        ["approved", "mergeable", "merged"].includes(
          sessionDisplayStatus(item, activeSessionIds),
        ),
      ),
    ],
  ] as const;
  if (sessions.length === 0 && !orchestrator) {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div className="max-w-sm">
          <OrchestratorIcon className="mx-auto size-5 text-[#4d8dff]" />
          <h2 className="mt-4 text-base">No cloud sessions</h2>
          <p className="mt-2 text-sm leading-6 text-white/45">
            Start the project orchestrator. AO will provision its sandbox and
            it can create isolated workers with normal AO commands.
          </p>
          {onCreateOrchestrator ? (
            <button
              className={`${primaryButton} mt-5`}
              onClick={onCreateOrchestrator}
              disabled={loading}
            >
              {loading ? (
                <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <Play className="size-3.5" />
              )}
              {loading ? "Starting…" : "Start orchestrator"}
            </button>
          ) : !agentAvailable ? (
            <button className={`${button} mt-5`} onClick={onOpenSettings}>
              <KeyRound className="size-3.5" />
              Connect an agent
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className="relative grid h-full min-h-0 min-w-[64rem] grid-cols-4 divide-x divide-white/10 overflow-x-auto xl:min-w-0">
      <div className="pointer-events-none absolute inset-x-0 top-12 z-10 border-t border-white/10" />
      {orchestrator &&
      !orchestrator.runtimeConnected &&
      !orchestrator.isTerminated ? (
        <RepositorySetupIndicator />
      ) : null}
      {columns.map(([title, dot, items]) => (
        <section
          key={title}
          aria-label={`${title} sessions`}
          className="min-w-[230px] overflow-auto"
        >
          <div className="flex h-12 items-center gap-2.5 px-4">
            <span
              className="size-[7px] rounded-full"
              style={{ background: dot }}
            />
            <h2 className="font-mono text-[10.5px] font-medium uppercase tracking-[0.05em] text-[#9ba1aa]">
              {title}
            </h2>
            <span className="ml-auto font-mono text-[10px] text-[#646a73]">
              {items.length}
            </span>
          </div>
          <div className="space-y-2 p-3">
            {items.map((cloudSession) => (
              <button
                key={cloudSession.id}
                className="group w-full rounded-lg border border-white/[0.06] bg-[#15171b] p-3 text-left transition-[border-color,box-shadow] hover:border-white/10 hover:shadow-sm"
                onClick={() => onSelect(cloudSession)}
              >
                <div className="flex items-center gap-2">
                  {cloudSession.kind === "orchestrator" ? (
                    <OrchestratorIcon className="size-[18px] shrink-0 text-[#9ba1aa]" />
                  ) : (
                    <AgentAvatar agent={cloudSession.harness} />
                  )}
                  <span className="truncate text-sm font-medium">
                    {cloudSession.displayName}
                  </span>
                  {sessionDisplayStatus(cloudSession, activeSessionIds) ===
                  "working" ? (
                    <LoaderCircle
                      className="ml-auto size-3.5 shrink-0 animate-spin text-[#4d8dff] motion-reduce:animate-none"
                      aria-label="Working"
                    />
                  ) : (
                    <span
                      className={`ml-auto size-[7px] shrink-0 rounded-full ${statusColor(cloudSession)}`}
                      aria-hidden="true"
                    />
                  )}
                </div>
                <div className="mt-3 flex items-center gap-2 font-mono text-[10px] text-[#646a73]">
                  <span className="min-w-0 flex-1 truncate">
                    {
                      projects.find(({ id }) => id === cloudSession.projectId)
                        ?.displayName
                    }
                  </span>
                  <span className="shrink-0 uppercase tracking-[0.04em]">
                    {sessionDisplayStatus(
                      cloudSession,
                      activeSessionIds,
                    ).replaceAll("_", " ")}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function CloudSettings({
  api,
  selectedOrg,
  incomingInvitations,
  orgInvitations,
  connections,
  sandboxProvider,
  run,
  loading,
}: {
  api: CloudAPI;
  selectedOrg?: CloudUserOrganization;
  incomingInvitations: CloudOrgInvitation[];
  orgInvitations: CloudOrgInvitation[];
  connections: ProviderConnection[];
  sandboxProvider: "daytona" | "fly";
  run: (operation: () => Promise<unknown>) => Promise<unknown>;
  loading: boolean;
}) {
  const [apiKey, setAPIKey] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member" | "viewer">(
    "member",
  );
  const [target, setTarget] = useState<"us" | "eu">("us");
  const selectedOrgId = selectedOrg?.organization.id;
  const canAdminOrg =
    selectedOrg?.membership.role === "owner" ||
    selectedOrg?.membership.role === "admin";
  const connectedAgents = new Map(
    connections
      .filter(
        ({ provider, validationState }) =>
          provider !== "daytona" && validationState === "valid",
      )
      .map((connection) => [connection.provider, connection]),
  );
  const daytonaConnections = connections.filter(
    ({ provider }) => provider === "daytona",
  );
  return (
    <div className="h-full overflow-auto p-6">
      <div className="max-w-2xl space-y-10">
        <section>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
            Organization
          </p>
          <h2 className="mt-2 text-base">
            {selectedOrg?.organization.displayName ?? "No organization selected"}
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-white/45">
            AO Cloud scopes projects, provider connections, workers, and
            invitations to the selected organization. Your current role is{" "}
            <span className="font-medium text-white/70">
              {selectedOrg?.membership.role ?? "viewer"}
            </span>
            .
          </p>
          <div className="mt-4 rounded-lg border border-white/10 bg-[#15171b] p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm">Pending invitations</p>
                <p className="text-xs text-white/35">
                  Invites persist in Postgres until accepted, declined, revoked,
                  or expired.
                </p>
              </div>
              <span className="font-mono text-[10px] uppercase text-white/35">
                {orgInvitations.length} pending
              </span>
            </div>
            {orgInvitations.length > 0 && (
              <div className="mt-3 space-y-2">
                {orgInvitations.map((invitation) => (
                  <div
                    key={invitation.id}
                    className="flex items-center gap-3 rounded-md border border-white/[0.06] bg-[#101216] px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {invitation.email}
                    </span>
                    <span className="font-mono text-[10px] uppercase text-white/35">
                      {invitation.role}
                    </span>
                    {selectedOrgId && (
                      <button
                        type="button"
                        className={button}
                        onClick={() =>
                          void run(() =>
                            api.revokeInvitation(selectedOrgId, invitation.id),
                          )
                        }
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {incomingInvitations.length > 0 && (
              <div className="mt-4 rounded-md border border-[#4d8dff]/20 bg-[#4d8dff]/10 p-3">
                <p className="text-sm text-white/80">Invitations for you</p>
                <div className="mt-2 space-y-2">
                  {incomingInvitations.map((invitation) => (
                    <div
                      key={invitation.id}
                      className="flex items-center gap-2 text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {invitation.email} as {invitation.role}
                      </span>
                      <button
                        type="button"
                        className={button}
                        onClick={() =>
                          void run(() => api.acceptInvitation(invitation.id))
                        }
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className={button}
                        onClick={() =>
                          void run(() => api.declineInvitation(invitation.id))
                        }
                      >
                        Decline
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {canAdminOrg && selectedOrgId && (
              <form
                className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_130px_auto]"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(() =>
                    api.inviteToOrg(selectedOrgId, {
                      email: inviteEmail,
                      role: inviteRole,
                    }),
                  ).then(() => setInviteEmail(""));
                }}
              >
                <input
                  className={field}
                  type="email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  placeholder="teammate@example.com"
                  required
                />
                <select
                  className={field}
                  value={inviteRole}
                  onChange={(event) =>
                    setInviteRole(event.target.value as typeof inviteRole)
                  }
                >
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                  <option value="viewer">Viewer</option>
                </select>
                <button className={primaryButton} type="submit">
                  Invite
                </button>
              </form>
            )}
          </div>
        </section>
        <section>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
            Coding agents
          </p>
          <h2 className="mt-2 text-base">Provider connections</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-white/45">
            Credentials are encrypted in AO Cloud and delivered only to an
            authenticated worker during bootstrap. Disconnected agents remain
            unavailable when creating sessions.
          </p>
          <p className="mt-2 max-w-xl text-xs leading-5 text-white/35">
            API keys and setup tokens are reused until you revoke or replace
            them. If a provider expires a credential, choose Re-authenticate to
            securely replace it; AO never returns the saved secret to this
            browser.
          </p>
          {canAdminOrg && selectedOrgId ? (
            <div className="mt-5 divide-y divide-white/10 border-y border-white/10">
              {CLOUD_AGENTS.map((agent) => (
                <AgentConnectionRow
                  key={agent.id}
                  agent={agent}
                  connection={connectedAgents.get(agent.id)}
                  run={run}
                  validating={loading}
                  connect={(credentialType, secret) =>
                    api.connectAgent(selectedOrgId, agent.id, {
                      credentialType,
                      secret,
                    })
                  }
                  disconnect={() =>
                    api.disconnectAgent(selectedOrgId, agent.id)
                  }
                />
              ))}
            </div>
          ) : (
            <div className="mt-5 rounded-lg border border-white/10 bg-[#15171b] px-3 py-2 text-sm text-white/45">
              Ask an organization admin to manage coding-agent connections.
            </div>
          )}
        </section>

        {!canAdminOrg || !selectedOrgId ? (
          <section>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
              Sandbox provider
            </p>
            <h2 className="mt-2 text-base">Provider settings</h2>
            <p className="mt-2 text-sm leading-6 text-white/45">
              Only organization admins can change sandbox provider settings.
            </p>
          </section>
        ) : sandboxProvider === "fly" ? (
          <section>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
              Sandbox provider
            </p>
            <h2 className="mt-2 text-base">Fly Machines</h2>
            <p className="mt-2 text-sm leading-6 text-white/45">
              AO Cloud provisions one isolated Fly Machine and persistent volume
              per session. Infrastructure credentials stay in the hosted control
              plane and are never returned to this browser.
            </p>
            <div className="mt-4 flex items-center rounded-lg border border-white/10 bg-[#15171b] px-3 py-2 text-sm">
              <span>Deployment-managed connection</span>
              <span className="ml-auto font-mono text-[10px] uppercase text-[#9ad97a]">
                Active
              </span>
            </div>
          </section>
        ) : (
          <section>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
              Sandbox provider
            </p>
            <h2 className="mt-2 text-base">Daytona</h2>
            <p className="mt-2 text-sm leading-6 text-white/45">
              Credentials are validated by AO Cloud, encrypted outside session
              environments, and never returned to this browser.
            </p>
            {daytonaConnections.map((connection) => (
              <div
                key={connection.id}
                className="mt-4 flex items-center border border-white/10 bg-[#15171b] px-3 py-2 text-sm"
              >
                <span>{connection.label}</span>
                <span className="ml-auto font-mono text-[10px] uppercase text-[#74b98a]">
                  {connection.validationState}
                </span>
              </div>
            ))}
            <form
              className="mt-5 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() =>
                  api.connectDaytona(selectedOrgId, {
                    label: "personal",
                    apiKey,
                    apiUrl: "https://app.daytona.io/api",
                    target,
                  }),
                ).then(() => setAPIKey(""));
              }}
            >
              <input
                className={field}
                type="password"
                value={apiKey}
                onChange={(event) => setAPIKey(event.target.value)}
                placeholder="Daytona API key"
                autoComplete="off"
                required
              />
              <select
                className={field}
                value={target}
                onChange={(event) =>
                  setTarget(event.target.value as "us" | "eu")
                }
              >
                <option value="us">United States</option>
                <option value="eu">Europe</option>
              </select>
              <button className={primaryButton} type="submit">
                Save and validate
              </button>
            </form>
          </section>
        )}
      </div>
    </div>
  );
}

function AgentConnectionRow({
  agent,
  connection,
  run,
  validating,
  connect,
  disconnect,
}: {
  agent: (typeof CLOUD_AGENTS)[number];
  connection?: ProviderConnection;
  run: (operation: () => Promise<unknown>) => Promise<unknown>;
  validating: boolean;
  connect: (
    credentialType: AgentCredentialType,
    secret: string,
  ) => Promise<unknown>;
  disconnect: () => Promise<unknown>;
}) {
  const [credentialType, setCredentialType] = useState<AgentCredentialType>(
    (connection?.config.credentialType as AgentCredentialType | undefined) ??
      agent.credentialTypes[0].id,
  );
  const [secret, setSecret] = useState("");
  const [replacing, setReplacing] = useState(false);
  const connected = Boolean(connection);
  const selectedCredential =
    agent.credentialTypes.find(({ id }) => id === credentialType) ??
    agent.credentialTypes[0];

  return (
    <div className="py-4">
      <div className="flex items-center gap-3">
        <AgentAvatar agent={agent.id} className="size-5" />
        <div className="min-w-0">
          <p className="text-sm">{agent.label}</p>
          <p
            className={`font-mono text-[10px] uppercase ${
              connected ? "text-[#74b98a]" : "text-white/30"
            }`}
          >
            {connected ? "Connected" : "Not available"}
          </p>
        </div>
        {connected && (
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className={button}
              disabled={validating}
              onClick={() => setReplacing((value) => !value)}
            >
              {replacing ? "Cancel" : "Re-authenticate"}
            </button>
            <button
              type="button"
              className={button}
              disabled={validating}
              onClick={() => void run(disconnect)}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
      {(!connected || replacing) && (
        <form
          className="mt-3 grid gap-2 pl-11 sm:grid-cols-[170px_minmax(0,1fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => connect(credentialType, secret)).then(() => {
              setSecret("");
              setReplacing(false);
            });
          }}
        >
          <select
            className={field}
            value={credentialType}
            onChange={(event) =>
              setCredentialType(event.target.value as AgentCredentialType)
            }
            aria-label={`${agent.label} credential type`}
          >
            {agent.credentialTypes.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.label}
              </option>
            ))}
          </select>
          <input
            className={field}
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={selectedCredential.placeholder}
            aria-label={`${agent.label} credential`}
            autoComplete="off"
            required
          />
          <button className={primaryButton} type="submit" disabled={validating}>
            {validating ? "Validating…" : "Connect"}
          </button>
        </form>
      )}
    </div>
  );
}

function Overlay({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
      <section className="w-full max-w-lg border border-white/15 bg-[#0f1013]">
        <header className="flex h-12 items-center border-b border-white/10 px-4">
          <h2 className="font-mono text-xs uppercase tracking-[0.12em]">
            {title}
          </h2>
          <button
            className="ml-auto text-white/45 hover:text-white"
            onClick={onClose}
            aria-label="Close"
          >
            <Square className="size-3" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function ProjectForm({
  repositories,
  repositoriesLoading,
  repositoriesError,
  loading,
  onClose,
  onSubmit,
}: {
  repositories: CloudRepository[];
  repositoriesLoading: boolean;
  repositoriesError: string | null;
  loading: boolean;
  onClose: () => void;
  onSubmit: (input: {
    displayName: string;
    repositoryUrl: string;
    defaultBranch: string;
  }) => Promise<void>;
}) {
  const [repositoryURL, setRepositoryURL] = useState(
    repositories[0]?.url ?? "",
  );
  useEffect(() => {
    setRepositoryURL((current) =>
      repositories.some(({ url }) => url === current)
        ? current
        : (repositories[0]?.url ?? ""),
    );
  }, [repositories]);
  const selected = repositories.find(({ url }) => url === repositoryURL);
  return (
    <Overlay title="Add cloud project" onClose={onClose}>
      <form
        className="space-y-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!selected) return;
          void onSubmit({
            displayName:
              selected.fullName.split("/").at(-1) ?? selected.fullName,
            repositoryUrl: selected.url,
            defaultBranch: selected.defaultBranch,
          });
        }}
      >
        <label className="block text-xs text-white/45">
          GitHub repository
          <select
            className={`${field} mt-1.5`}
            value={repositoryURL}
            onChange={(event) => setRepositoryURL(event.target.value)}
            disabled={loading || repositoriesLoading}
          >
            {repositories.map((repository) => (
              <option value={repository.url} key={repository.url}>
                {repository.fullName}
                {repository.private ? " · private" : ""}
              </option>
            ))}
          </select>
        </label>
        {repositoriesLoading ? (
          <p className="text-sm text-muted-foreground">
            Loading GitHub repositories…
          </p>
        ) : repositoriesError ? (
          <p className="text-sm text-destructive">{repositoriesError}</p>
        ) : repositories.length === 0 ? (
          <p className="text-sm text-[#e8c14a]">
            No repositories were returned by the configured GitHub connection.
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={button}
            onClick={onClose}
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={primaryButton}
            disabled={!selected || loading || repositoriesLoading}
          >
            {loading ? "Starting…" : "Add project"}
          </button>
        </div>
      </form>
    </Overlay>
  );
}

function SessionForm({
  projectId,
  providerConnectionId,
  connections,
  loading,
  onOpenSettings,
  onClose,
  onSubmit,
}: {
  projectId: string;
  providerConnectionId?: string;
  connections: ProviderConnection[];
  loading: boolean;
  onOpenSettings: () => void;
  onClose: () => void;
  onSubmit: (input: {
    projectId: string;
    kind: "worker";
    harness: string;
    displayName: string;
    prompt: string;
    providerConnectionId?: string;
  }) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState("");
  const [prompt, setPrompt] = useState("");
  const availableAgents = connectedAgentIDs(connections);
  const [harness, setHarness] = useState<CloudAgent | "">(
    defaultConnectedAgent(connections) ?? "",
  );
  return (
    <Overlay title="New cloud worker" onClose={onClose}>
      <form
        className="space-y-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!harness) return;
          void onSubmit({
            projectId,
            kind: "worker",
            harness,
            displayName,
            prompt,
            providerConnectionId,
          });
        }}
      >
        <input
          className={field}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Worker name"
          required
          maxLength={40}
        />
        <div className="relative">
          {harness ? (
            <AgentAvatar
              agent={harness}
              className="pointer-events-none absolute left-3 top-1/2 z-10 size-[18px] -translate-y-1/2"
            />
          ) : null}
          <select
            className={`${field} ${harness ? "pl-10" : ""}`}
            value={harness}
            onChange={(event) =>
              setHarness(event.target.value as CloudAgent | "")
            }
            aria-label="Coding agent"
            required
          >
            <option value="" disabled>
              Select coding agent
            </option>
            {CLOUD_AGENTS.map((agent) => {
              const available = availableAgents.has(agent.id);
              return (
                <option key={agent.id} value={agent.id} disabled={!available}>
                  {agent.label}
                  {available ? "" : " — Not available"}
                </option>
              );
            })}
          </select>
        </div>
        {availableAgents.size === 0 && (
          <button
            type="button"
            className="text-left text-xs text-[#e8c14a] hover:underline"
            onClick={onOpenSettings}
          >
            Connect a coding agent in Cloud settings.
          </button>
        )}
        <textarea
          className="min-h-32 w-full resize-y rounded-md border border-border bg-background p-3 text-sm outline-none focus:border-[#4d8dff]"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="What should this worker do?"
          required
        />
        <div className="flex justify-end gap-2">
          <button type="button" className={button} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className={primaryButton}
            disabled={!harness || loading}
          >
            {loading ? (
              <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
            ) : null}
            {loading ? "Spawning…" : "Spawn worker"}
          </button>
        </div>
      </form>
    </Overlay>
  );
}
