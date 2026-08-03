"use client";

import {
  Bell,
  Building2,
  ChevronRight,
  Check,
  ChevronsUpDown,
  Cloud,
  Copy,
  Eye,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Github,
  GitPullRequest,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  PencilLine,
  Play,
  Plus,
  RefreshCw,
  Settings,
  Square,
  Trash2,
  User,
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
  CloudAPIError,
  type AgentCredentialsMode,
  type AgentCredentialType,
  type CloudAgent,
  type CloudGitHubConnection,
  type CloudGitHubGrantedRepository,
  type CloudGitHubInstallation,
  type CloudOrgMember,
  type CloudOrgMembership,
  type CloudOrgInvitation,
  type CloudProject,
  type CloudProjectShareAccess,
  type CloudRepository,
  type CloudSession,
  type CloudSessionSCM,
  type CloudSharedProject,
  type CloudUser,
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

async function hydrateSharedProjectSessions(
  api: CloudAPI,
  shares: CloudSharedProject[],
) {
  const sessionsByOrg = new Map<string, CloudSession[]>();
  await Promise.all(
    [...new Set(shares.map(({ orgId }) => orgId))].map(async (orgId) => {
      try {
        sessionsByOrg.set(orgId, (await api.sessions(orgId)).sessions);
      } catch {
        sessionsByOrg.set(orgId, []);
      }
    }),
  );
  return shares.map((share) => ({
    ...share,
    sessions: (sessionsByOrg.get(share.orgId) ?? []).filter(
      (cloudSession) =>
        cloudSession.projectId === share.project.id &&
        (!share.session || cloudSession.id === share.session.id),
    ),
  }));
}

export default function CloudAppPage() {
  const { session, status, logout } = useAuth();
  const api = useMemo(
    () => (session?.accessToken ? new CloudAPI(session.accessToken) : null),
    [session?.accessToken],
  );
  useEffect(() => {
    if (status === "unauthenticated") {
      window.location.replace("/auth");
    }
  }, [status]);
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [sessions, setSessions] = useState<CloudSession[]>([]);
  const [sharedProjects, setSharedProjects] = useState<CloudSharedProject[]>([]);
  const [sessionSCM, setSessionSCM] = useState<Record<string, CloudSessionSCM | null>>({});
  const [organizations, setOrganizations] = useState<CloudUserOrganization[]>(
    [],
  );
  const [currentUser, setCurrentUser] = useState<CloudUser | null>(null);
  const [incomingInvitations, setIncomingInvitations] = useState<
    CloudOrgInvitation[]
  >([]);
  const [orgInvitations, setOrgInvitations] = useState<CloudOrgInvitation[]>([]);
  const [orgMembers, setOrgMembers] = useState<CloudOrgMember[]>([]);
  const [repositories, setRepositories] = useState<CloudRepository[]>([]);
  const [repositoriesLoading, setRepositoriesLoading] = useState(false);
  const [repositoriesError, setRepositoriesError] = useState<string | null>(
    null,
  );
  const [githubConnection, setGitHubConnection] =
    useState<CloudGitHubConnection | null>(null);
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [agentCredentialsMode, setAgentCredentialsMode] =
    useState<AgentCredentialsMode>("custom");
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
  const [selectedShareId, setSelectedShareId] = useState<string | null>(null);
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
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [projectMenuOpenId, setProjectMenuOpenId] = useState<string | null>(null);
  const [shareProject, setShareProject] = useState<CloudProject | null>(null);
  const [shareRole, setShareRole] = useState<"viewer" | "editor">("viewer");
  const [shareAccessScope, setShareAccessScope] = useState<
    "anyone" | "restricted"
  >("anyone");
  const [shareRecipientEmails, setShareRecipientEmails] = useState("");
  const [shareRecipientOrgIds, setShareRecipientOrgIds] = useState<string[]>([]);
  const [shareAccess, setShareAccess] = useState<CloudProjectShareAccess | null>(
    null,
  );
  const [shareAccessLoading, setShareAccessLoading] = useState(false);
  const [shareLink, setShareLink] = useState("");
  const [shareCopied, setShareCopied] = useState(false);
  const [settingsPanelTarget, setSettingsPanelTarget] = useState<
    "profile" | "notifications" | "createOrg" | "org" | "agents" | "sandbox"
  >(() =>
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("settings") === "github"
      ? "agents"
      : "org",
  );
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
      ) as { orgId?: string; projectId?: string; sessionId?: string };
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
      if (savedSelection.orgId) {
        selectedOrgIdRef.current = savedSelection.orgId;
        setSelectedOrgId(savedSelection.orgId);
      }
      const url = new URL(window.location.href);
      const openSettings = url.searchParams.has("settings");
      setView(openSettings ? "settings" : "board");
      if (openSettings) {
        url.searchParams.delete("settings");
        window.history.replaceState({}, "", url.pathname + url.search + url.hash);
      }
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
        orgId: selectedOrgId,
        projectId: selectedProjectId,
        sessionId: selectedSessionId,
      }),
    );
  }, [selectedOrgId, selectedProjectId, selectedSessionId, selectionRestored]);

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

  const selectedShare = selectedShareId
    ? sharedProjects.find(({ id }) => id === selectedShareId)
    : undefined;
  const activeOrgId = selectedShare?.orgId ?? selectedOrgId;
  const activeSessions = selectedShare?.sessions ?? sessions;
  const connectedWorkspaceSessionIDs = useMemo(
    () =>
      activeSessions
        .filter((cloudSession) => cloudSession.runtimeConnected)
        .map((cloudSession) => cloudSession.id)
        .sort(),
    [activeSessions],
  );
  const connectedWorkspaceSessionKey = connectedWorkspaceSessionIDs.join(",");
  useEffect(() => {
    selectedOrgIdRef.current = selectedOrgId;
  }, [selectedOrgId]);
  useEffect(() => {
    if (!api || !activeOrgId) return;
    const activeSessionIDs = new Set(connectedWorkspaceSessionIDs);
    removeWorkspaceSnapshots(activeSessionIDs);
    const warmAll = () => {
      for (const sessionID of connectedWorkspaceSessionIDs) {
        void warmWorkspaceSession(api, activeOrgId, sessionID);
      }
    };
    warmAll();
    const refreshTimer = window.setInterval(warmAll, 3_000);
    return () => window.clearInterval(refreshTimer);
    // The stable key avoids restarting this timer on every status refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrgId, api, connectedWorkspaceSessionKey]);
  useEffect(() => {
    if (!api || !activeOrgId) {
      clearCloudTerminalConnections();
      return;
    }
    syncCloudTerminalConnections(api, activeOrgId, connectedWorkspaceSessionIDs);
    // The stable key avoids reconnecting every terminal on status refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrgId, api, connectedWorkspaceSessionKey]);
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
        const [runtimeData, incomingInvitationData, sharedData] = await Promise.all([
          api.me(),
          api.invitations(),
          typeof api.sharedProjects === "function"
            ? api.sharedProjects().catch(() => ({ shares: [] }))
            : Promise.resolve({ shares: [] }),
        ]);
        const hydratedShares = await hydrateSharedProjectSessions(
          api,
          sharedData.shares,
        );
        setCurrentUser(runtimeData.user ?? session?.user ?? null);
        setIncomingInvitations(incomingInvitationData.invitations);
        setSharedProjects(hydratedShares);
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
          setSharedProjects(hydratedShares);
          setConnections([]);
          setAgentCredentialsMode("custom");
          setGitHubConnection(null);
          setOrgInvitations([]);
          setOrgMembers([]);
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
          githubData,
          orgMemberData,
          orgInvitationData,
        ] = await Promise.all([
          api.projects(nextOrgId),
          api.sessions(nextOrgId),
          api.providerConnections(nextOrgId),
          api.githubConnection(nextOrgId),
          api.orgMembers(nextOrgId),
          canLoadOrgInvitations
            ? api.orgInvitations(nextOrgId)
            : Promise.resolve({ invitations: [] }),
        ]);
        setProjects(projectData.projects);
        setSessions(sessionData.sessions);
        const authoritativeActive = new Set(
          [
            ...sessionData.sessions,
            ...hydratedShares.flatMap(({ sessions: sharedSessions }) =>
              sharedSessions ?? [],
            ),
          ]
            .filter(
              (cloudSession) =>
                cloudSession.status === "working" ||
                cloudSession.activeTurn !== undefined,
            )
            .map(({ id }) => id),
        );
        setActiveChatSessionIds(authoritativeActive);
        setConnections(connectionData.providerConnections);
        setAgentCredentialsMode(connectionData.agentCredentialsMode ?? "custom");
        setGitHubConnection(githubData);
        setOrgMembers(orgMemberData.members);
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
  }, [api, session?.user]);

  useEffect(() => {
    if (!api) return;
    const url = new URL(window.location.href);
    const token = url.searchParams.get("share");
    if (!token) return;
    url.searchParams.delete("share");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    void (async () => {
      setLoading(true);
      try {
        const redeemed = await api.redeemProjectShareLink(token);
        const [hydratedShare] = await hydrateSharedProjectSessions(api, [
          redeemed.share,
        ]);
        setSharedProjects((current) => [
          hydratedShare,
          ...current.filter(({ id }) => id !== hydratedShare.id),
        ]);
        const orchestrator = hydratedShare.sessions?.find(
          ({ kind, isTerminated }) => kind === "orchestrator" && !isTerminated,
        );
        setSelectedShareId(hydratedShare.id);
        setSelectedProjectId(hydratedShare.project.id);
        setSelectedSessionId(
          orchestrator?.id ?? hydratedShare.sessions?.[0]?.id ?? null,
        );
        setView(
          orchestrator || (hydratedShare.sessions?.length ?? 0) > 0
            ? "session"
            : "board",
        );
        setError(null);
      } catch (shareError) {
        if (
          shareError instanceof CloudAPIError &&
          shareError.code === "SHARE_SELF_REDEEM"
        ) {
          setError(null);
          return;
        }
        setError(
          shareError instanceof Error
            ? shareError.message
            : "Could not redeem this share link.",
        );
      } finally {
        setLoading(false);
      }
    })();
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

  const selectedProject =
    selectedShare?.project ??
    projects.find(({ id }) => id === selectedProjectId);
  const selectedSession =
    selectedShare?.sessions?.find(({ id }) => id === selectedSessionId) ??
    sessions.find(({ id }) => id === selectedSessionId);
  const selectedOrg = organizations.find(
    ({ organization }) => organization.id === selectedOrgId,
  );
  const pendingInvitationCount =
    incomingInvitations.filter((invitation) => invitation.status === "pending")
      .length +
    orgInvitations.filter((invitation) => invitation.status === "pending")
      .length;
  const switchOrg = (nextOrgId: string | null) => {
    selectedOrgIdRef.current = nextOrgId;
    setSelectedOrgId(nextOrgId);
    setSelectedProjectId(null);
    setSelectedSessionId(null);
    setSelectedShareId(null);
    setView("board");
    setWorkspaceMenuOpen(false);
  };
  const openProviderSettings = () => {
    setSettingsPanelTarget("agents");
    setView("settings");
  };
  const selectedOrgRole =
    selectedOrg?.membership.role ?? selectedShare?.role ?? "viewer";
  const canEditOrg =
    selectedOrgRole === "owner" ||
    selectedOrgRole === "admin" ||
    selectedOrgRole === "member" ||
    selectedOrgRole === "editor";
  const terminalRuntimeAvailable =
    selectedSession?.capabilities?.includes("runtime.pty.v1") === true;
  const daytonaConnections = connections.filter(
    ({ provider }) => provider === "daytona",
  );
  const defaultAgent = defaultConnectedAgent(connections);
  const selectedProjectOrchestrator = activeSessions.find(
    ({ projectId, kind, isTerminated }) =>
      projectId === selectedProjectId &&
      kind === "orchestrator" &&
      !isTerminated,
  );
  const workerSessions = activeSessions.filter(({ kind }) => kind === "worker");
  const visibleSessions = selectedProjectId
    ? workerSessions.filter(({ projectId }) => projectId === selectedProjectId)
    : workerSessions;
  const visibleSessionSCMKey = visibleSessions
    .map(({ id, status }) => `${id}:${status}`)
    .sort()
    .join(",");

  useEffect(() => {
    if (!api || !activeOrgId || visibleSessions.length === 0) {
      setSessionSCM({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      visibleSessions.map(async (cloudSession) => {
        try {
          const result = await api.sessionSCM(activeOrgId, cloudSession.id);
          return [cloudSession.id, result.scm] as const;
        } catch {
          return [cloudSession.id, null] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setSessionSCM(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
    // visibleSessionSCMKey keeps this from depending on the array identity that
    // changes on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrgId, api, visibleSessionSCMKey]);

  useEffect(() => {
    if (initialLoading || !selectedSessionId) return;
    const restoredSession = selectedShare
      ? selectedShare.sessions?.find(({ id }) => id === selectedSessionId)
      : sessions.find(({ id }) => id === selectedSessionId);
    if (!restoredSession) {
      setSelectedSessionId(null);
      setView("board");
      return;
    }
    if (selectedProjectId !== restoredSession.projectId) {
      setSelectedProjectId(restoredSession.projectId);
    }
  }, [
    initialLoading,
    selectedProjectId,
    selectedSessionId,
    selectedShare,
    sessions,
  ]);

  useEffect(() => {
    if (
      initialLoading ||
      !selectedProjectId ||
      (selectedShare
        ? selectedShare.project.id === selectedProjectId
        : projects.some(({ id }) => id === selectedProjectId))
    ) {
      return;
    }
    setSelectedProjectId(null);
    setSelectedSessionId(null);
    setView("board");
  }, [initialLoading, projects, selectedProjectId, selectedShare]);

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

  const loadProjectShareAccess = useCallback(async () => {
    if (!api || !selectedOrgId || !shareProject) {
      setShareAccess(null);
      return;
    }
    setShareAccessLoading(true);
    try {
      const result = await api.projectShareAccess(selectedOrgId, shareProject.id);
      setShareAccess(result.access);
    } catch (accessError) {
      setError(
        accessError instanceof Error
          ? accessError.message
          : "Could not load shared access.",
      );
    } finally {
      setShareAccessLoading(false);
    }
  }, [api, selectedOrgId, shareProject]);

  useEffect(() => {
    if (!shareProject) return;
    void loadProjectShareAccess();
  }, [loadProjectShareAccess, shareProject]);

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
    if (
      !api ||
      !selectedOrgId ||
      selectedShare ||
      !selectedProjectId ||
      !defaultAgent ||
      !canEditOrg
    )
      return;
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
    githubRepositoryId?: number;
  }) => {
    if (!api || !selectedOrgId || selectedShare || !defaultAgent || !canEditOrg) {
      setError("Connect a coding agent before creating a cloud project.");
      openProviderSettings();
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
    if (!api || !activeOrgId || !selectedSession || selectedSession.kind !== "worker") return;
    const confirmed = window.confirm(
      `Delete ${selectedSession.displayName}'s cloud session, machine, and workspace volume?\n\nThis removes the worker from the board after the control plane tears down its sandbox.`,
    );
    if (!confirmed) return;
    const deleted = await run(() =>
      api.setDesiredState(activeOrgId, selectedSession.id, "deleted"),
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

  const createProjectShareLink = async () => {
    if (!api || !selectedOrgId || !shareProject) return;
    const recipientEmails = shareRecipientEmails
      .split(/[\n,]/)
      .map((email) => email.trim())
      .filter(Boolean);
    if (
      shareAccessScope === "restricted" &&
      recipientEmails.length === 0 &&
      shareRecipientOrgIds.length === 0
    ) {
      setError("Add at least one email or workspace for restricted sharing.");
      return;
    }
    await run(async () => {
      const result = await api.createProjectShareLink(
        selectedOrgId,
        shareProject.id,
        {
          role: shareRole,
          accessScope: shareAccessScope,
          recipientEmails,
          recipientOrgIds: shareRecipientOrgIds,
        },
      );
      const url = new URL(window.location.href);
      url.pathname = "/app";
      url.search = "";
      url.searchParams.set("share", result.token);
      setShareLink(url.toString());
      setShareCopied(false);
      await loadProjectShareAccess();
    });
  };

  const updateShareGrantRole = async (
    grantId: string,
    role: "viewer" | "editor",
  ) => {
    if (!api || !selectedOrgId || !shareProject) return;
    await run(async () => {
      await api.updateProjectShareGrant(selectedOrgId, shareProject.id, grantId, {
        role,
      });
      await loadProjectShareAccess();
    });
  };

  const revokeShareGrant = async (grantId: string) => {
    if (!api || !selectedOrgId || !shareProject) return;
    await run(async () => {
      await api.revokeProjectShareGrant(selectedOrgId, shareProject.id, grantId);
      await loadProjectShareAccess();
      await refresh();
    });
  };

  const revokeShareLink = async (linkId: string) => {
    if (!api || !selectedOrgId || !shareProject) return;
    await run(async () => {
      await api.revokeProjectShareLink(selectedOrgId, shareProject.id, linkId);
      await loadProjectShareAccess();
    });
  };

  const closeProjectShare = () => {
    setShareProject(null);
    setShareRole("viewer");
    setShareAccessScope("anyone");
    setShareRecipientEmails("");
    setShareRecipientOrgIds([]);
    setShareAccess(null);
    setShareLink("");
    setShareCopied(false);
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
      <main
        className="min-h-dvh bg-[#0a0b0d]"
        aria-label="Redirecting to sign in"
      />
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
            <div className="relative mx-1.5 mb-2">
              <button
                type="button"
                className="flex h-12 w-full items-center gap-2 rounded-lg border border-white/[0.06] bg-[#111317] px-2 text-left transition-colors hover:bg-[#191b20] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d8dff]/70"
                onClick={() => setWorkspaceMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={workspaceMenuOpen}
              >
                <span className="grid size-6 shrink-0 place-items-center rounded-md border border-white/[0.08] bg-[#1a1c22] text-[11px] uppercase leading-none text-white/60">
                  {(selectedOrg?.organization.displayName ?? "A").charAt(0)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] leading-4 text-white">
                    {selectedOrg?.organization.displayName ?? "Select workspace"}
                  </span>
                  <span className="block truncate text-[11px] leading-4 text-white/35">
                    {currentUser?.email ?? session?.user.email ?? "Signed in"} ·{" "}
                    {selectedOrg?.membership.role ?? "viewer"}
                  </span>
                </span>
                {incomingInvitations.length > 0 ? (
                  <span
                    className="grid size-4 place-items-center rounded-full bg-[#4d8dff] font-mono text-[9px] text-white"
                    aria-label={`${incomingInvitations.length} pending invitations`}
                  >
                    {incomingInvitations.length}
                  </span>
                ) : null}
                <ChevronsUpDown className="size-3.5 shrink-0 text-white/35" />
              </button>
              {workspaceMenuOpen ? (
                <div
                  role="menu"
                  className="absolute left-0 right-0 top-[calc(100%+6px)] z-40 overflow-hidden rounded-xl border border-white/10 bg-[#202126] p-1.5 shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
                >
                  <div className="truncate px-2 py-1.5 text-[11px] leading-4 text-white/40">
                    {currentUser?.email ?? session?.user.email ?? "Account"}
                  </div>
                  {organizations.map(({ organization, membership }) => (
                    <button
                      key={organization.id}
                      role="menuitemradio"
                      aria-checked={organization.id === selectedOrgId}
                      type="button"
                      className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] ${
                        organization.id === selectedOrgId
                          ? "bg-white/[0.08] text-white"
                          : "text-white/70 hover:bg-white/[0.05] hover:text-white"
                      }`}
                      onClick={() => switchOrg(organization.id)}
                    >
                      <Building2 className="size-3.5 shrink-0 text-white/45" />
                      <span className="min-w-0 flex-1 truncate">
                        {organization.displayName}
                      </span>
                      <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.04em] text-white/35">
                        {membership.role}
                      </span>
                      {organization.id === selectedOrgId ? (
                        <Check className="size-3.5 shrink-0 text-white/70" />
                      ) : null}
                    </button>
                  ))}
                  <div className="my-1 h-px bg-white/[0.08]" />
                  <button
                    type="button"
                    role="menuitem"
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-white/70 hover:bg-white/[0.05] hover:text-white"
                    onClick={() => {
                      setWorkspaceMenuOpen(false);
                      setSettingsPanelTarget("createOrg");
                      setView("settings");
                    }}
                  >
                    <Plus className="size-3.5 shrink-0 text-white/45" />
                    <span className="truncate">Create workspace</span>
                  </button>
                </div>
              ) : null}
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
              setSelectedShareId(null);
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
                else {
                  setSettingsPanelTarget("agents");
                  setView("settings");
                }
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
                  <div className="group relative flex items-center">
                    <button
                      className={`flex h-8 min-w-0 flex-1 items-center rounded-lg text-left text-sm ${
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
                        setSelectedShareId(null);
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
                    {!sidebarCollapsed && canEditOrg ? (
                      <button
                        type="button"
                        className={`mr-0.5 grid size-7 shrink-0 place-items-center rounded-md text-[#646a73] hover:bg-white/[0.06] hover:text-white ${
                          projectMenuOpenId === project.id
                            ? "bg-white/[0.06] text-white"
                            : "opacity-0 group-hover:opacity-100 focus:opacity-100"
                        }`}
                        aria-label={`More actions for ${project.displayName}`}
                        aria-expanded={projectMenuOpenId === project.id}
                        onClick={() =>
                          setProjectMenuOpenId((current) =>
                            current === project.id ? null : project.id,
                          )
                        }
                      >
                        <MoreHorizontal className="size-3.5" />
                      </button>
                    ) : null}
                    {projectMenuOpenId === project.id ? (
                      <div className="absolute right-0 top-8 z-40 w-36 rounded-lg border border-white/[0.1] bg-[#15171b] p-1 shadow-xl shadow-black/30">
                        <button
                          type="button"
                          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-white/70 hover:bg-white/[0.06] hover:text-white"
                          onClick={() => {
                            setProjectMenuOpenId(null);
                            setShareProject(project);
                            setShareRole("viewer");
                            setShareLink("");
                          }}
                        >
                          <ExternalLink className="size-3.5" />
                          Share project
                        </button>
                      </div>
                    ) : null}
                  </div>
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
                            setSelectedShareId(null);
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
          {sharedProjects.length > 0 ? (
            <div className="border-t border-white/[0.06] px-1.5 py-3">
              <div
                className={`mb-1 flex items-center ${
                  sidebarCollapsed ? "justify-center" : "justify-between px-1.5"
                }`}
              >
                {!sidebarCollapsed ? (
                  <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.05em] text-[#646a73]">
                    Shared
                  </span>
                ) : null}
              </div>
              <div className="space-y-1">
                {sharedProjects.map((share) => {
                  const disclosureID = `shared:${share.id}`;
                  const expanded = !collapsedProjectIds.has(disclosureID);
                  const projectActive =
                    selectedShareId === share.id &&
                    selectedProjectId === share.project.id &&
                    view === "board";
                  const sharedBy = share.sharedByName || share.sharedByEmail;
                  return (
                    <div key={share.id} className="mb-1">
                      <div className="flex items-center">
                        {!sidebarCollapsed ? (
                          <button
                            type="button"
                            className="grid size-8 shrink-0 place-items-center rounded-lg text-[#646a73] hover:bg-white/[0.04] hover:text-white"
                            onClick={() => {
                              setCollapsedProjectIds((current) => {
                                const next = new Set(current);
                                if (expanded) {
                                  next.add(disclosureID);
                                } else {
                                  next.delete(disclosureID);
                                }
                                return next;
                              });
                            }}
                            aria-label={`${expanded ? "Collapse" : "Expand"} ${share.project.displayName}`}
                            aria-expanded={expanded}
                          >
                            <ChevronRight
                              className={`size-3.5 transition-transform duration-150 motion-reduce:transition-none ${
                                expanded ? "rotate-90" : ""
                              }`}
                              strokeWidth={2.5}
                              aria-hidden="true"
                            />
                          </button>
                        ) : null}
                        <button
                          className={`flex h-8 min-w-0 flex-1 items-center rounded-lg text-left text-[12px] ${
                            sidebarCollapsed
                              ? "justify-center px-0"
                              : "gap-2 px-2"
                          } ${
                            projectActive
                              ? "bg-white/[0.07] text-white"
                              : "text-[#9ba1aa] hover:bg-white/[0.04] hover:text-white"
                          }`}
                          onClick={() => {
                            setSelectedShareId(share.id);
                            setSelectedProjectId(share.project.id);
                            setSelectedSessionId(null);
                            setView("board");
                          }}
                          aria-label={`${share.project.displayName}, shared by ${sharedBy}`}
                          title={
                            sidebarCollapsed
                              ? `${share.project.displayName} shared by ${sharedBy}`
                              : undefined
                          }
                        >
                          <FolderGit2 className="size-[15px] shrink-0" />
                          {!sidebarCollapsed ? (
                            <span className="truncate">
                              {share.project.displayName}
                            </span>
                          ) : null}
                        </button>
                      </div>
                      {!sidebarCollapsed ? (
                        <div className="ml-[42px] -mt-0.5 truncate pr-2 text-[10px] text-white/30">
                          {sharedBy} · {share.role}
                        </div>
                      ) : null}
                      {expanded ? (
                        <div
                          className={
                            sidebarCollapsed
                              ? ""
                              : "ml-[15px] mt-1 border-l border-white/[0.06] pl-1.5"
                          }
                        >
                          {(share.sessions ?? []).map((cloudSession) => (
                            <button
                              key={cloudSession.id}
                              className={`flex h-7 w-full items-center rounded-lg text-left text-[12px] ${
                                sidebarCollapsed
                                  ? "justify-center px-0"
                                  : "gap-2 border-l-2 px-2"
                              } ${
                                selectedShareId === share.id &&
                                selectedSessionId === cloudSession.id &&
                                view === "session"
                                  ? "border-[#4d8dff] bg-white/[0.07] text-white"
                                  : "border-transparent text-[#9ba1aa] hover:bg-white/[0.04] hover:text-white"
                              }`}
                              onClick={() => {
                                setSelectedShareId(share.id);
                                setSelectedProjectId(share.project.id);
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
                          {(share.sessions?.length ?? 0) === 0 &&
                          !sidebarCollapsed ? (
                            <div className="px-2 py-1 text-[10px] text-white/25">
                              No sessions yet
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div className="min-h-[105px] shrink-0 border-t border-white/[0.06] p-1.5">
            <button
              className={`relative flex h-8 w-full items-center rounded-lg text-sm text-[#9ba1aa] hover:bg-white/[0.04] hover:text-white ${
                sidebarCollapsed ? "justify-center px-0" : "gap-2 px-2"
              }`}
              onClick={() => {
                setSettingsPanelTarget("org");
                setView("settings");
              }}
              aria-label="Settings"
              title={sidebarCollapsed ? "Settings" : undefined}
            >
              <Settings className="size-[15px] shrink-0" />
              {!sidebarCollapsed ? (
                <>
                  <span>Settings</span>
                  {pendingInvitationCount > 0 ? (
                    <span
                      className="ml-auto grid size-4 place-items-center rounded-full bg-[#4d8dff] font-mono text-[9px] text-white"
                      aria-label={`${pendingInvitationCount} settings notifications`}
                    >
                      {pendingInvitationCount}
                    </span>
                  ) : null}
                </>
              ) : pendingInvitationCount > 0 ? (
                <span className="absolute mt-[-16px] ml-4 size-1.5 rounded-full bg-[#4d8dff]" />
              ) : null}
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
                  {selectedSession.kind === "worker" && canEditOrg ? (
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
                    disabled={loading || !canEditOrg || Boolean(selectedShare)}
                  >
                    <Plus className="size-3.5" />
                    New task
                  </button>
                  <button
                    className={button}
                    disabled={
                      loading ||
                      !canEditOrg ||
                      (!selectedProjectOrchestrator &&
                        (!defaultAgent || Boolean(selectedShare)))
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
                currentUser={currentUser ?? session?.user ?? null}
                organizations={organizations}
                selectedOrg={selectedOrg}
                selectedOrgId={selectedOrgId}
                onBack={() => setView("board")}
                onSelectOrg={(orgId) => {
                  switchOrg(orgId);
                  setSettingsPanelTarget("org");
                  setView("settings");
                }}
                incomingInvitations={incomingInvitations}
                orgInvitations={orgInvitations}
                orgMembers={orgMembers}
                connections={connections}
                githubConnection={githubConnection}
                agentCredentialsMode={agentCredentialsMode}
                sandboxProvider={sandboxProvider}
                initialPanel={settingsPanelTarget}
                run={run}
                loading={loading}
              />
            ) : view === "session" && selectedSession && activeOrgId ? (
              terminalRuntimeAvailable ? (
                <div className="flex h-full min-h-0 min-w-0">
                  <div className="min-h-0 min-w-0 flex-1">
                    <CloudTerminal
                      api={api}
                      orgId={activeOrgId}
                      sessionId={selectedSession.id}
                      layoutKey={inspectorOpen ? "inspector-open" : "inspector-closed"}
                    />
                  </div>
                  <CloudInspector
                    key={selectedSession.id}
                    api={api}
                    orgId={activeOrgId}
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
                projects={selectedShare ? [selectedShare.project] : projects}
                scmBySessionId={sessionSCM}
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
                  !selectedShare &&
                  !selectedProjectOrchestrator
                    ? startOrchestrator
                    : undefined
                }
                agentAvailable={Boolean(defaultAgent)}
                loading={loading}
                onOpenSettings={openProviderSettings}
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
          githubConnection={githubConnection}
          loading={loading}
          onOpenGitHubSettings={() => {
            setShowProjectForm(false);
            setSettingsPanelTarget("agents");
            window.history.replaceState({}, "", "/app?settings=github");
            setView("settings");
          }}
          onClose={() => setShowProjectForm(false)}
          onSubmit={createProjectAndPrewarmOrchestrator}
        />
      )}
      {shareProject ? (
        <Overlay title="Share project" onClose={closeProjectShare}>
          <div className="space-y-6 p-5 sm:p-6">
            <div className="flex items-center gap-4 rounded-xl border border-white/[0.08] bg-white/[0.025] p-4">
              <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-white/[0.09] bg-white/[0.04]">
                <FolderGit2 className="size-4 text-white/55" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-white/85">
                  {shareProject.displayName}
                </div>
                <div className="mt-1 text-xs leading-5 text-white/35">
                  Access is limited to this project and its sessions.
                </div>
              </div>
            </div>

            <div>
              <div className="mb-3 text-xs font-medium text-white/50">
                Permission
              </div>
              <div
                className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                role="radiogroup"
                aria-label="Permission"
              >
                {[
                  {
                    role: "viewer" as const,
                    label: "Viewer",
                    description: "View sessions and terminal output",
                    icon: Eye,
                  },
                  {
                    role: "editor" as const,
                    label: "Editor",
                    description: "Interact with existing sessions",
                    icon: PencilLine,
                  },
                ].map((option) => {
                  const selected = shareRole === option.role;
                  const Icon = option.icon;
                  return (
                    <button
                      key={option.role}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={loading}
                      className={`relative min-h-[108px] rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d8dff]/70 ${
                        selected
                          ? "border-[#4d8dff]/55 bg-[#4d8dff]/10"
                          : "border-white/[0.07] bg-white/[0.02] hover:border-white/[0.13] hover:bg-white/[0.04]"
                      }`}
                      onClick={() => {
                        setShareRole(option.role);
                        setShareLink("");
                        setShareCopied(false);
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <Icon
                          className={`size-4 ${
                            selected ? "text-[#75a5ff]" : "text-white/40"
                          }`}
                        />
                        <span className="text-sm font-medium text-white/85">
                          {option.label}
                        </span>
                        {selected ? (
                          <span className="ml-auto grid size-4 place-items-center rounded-full bg-[#4d8dff] text-white">
                            <Check className="size-2.5" strokeWidth={3} />
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-3 text-xs leading-5 text-white/35">
                        {option.description}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-3">
              <div className="text-xs font-medium text-white/50">
                Link access
              </div>
              <div className="grid grid-cols-2 gap-2">
                {[
                  {
                    scope: "anyone" as const,
                    label: "Anyone with link",
                    description: "Any signed-in AO user can redeem it",
                  },
                  {
                    scope: "restricted" as const,
                    label: "Restricted",
                    description: "Only listed people or workspaces",
                  },
                ].map((option) => {
                  const selected = shareAccessScope === option.scope;
                  return (
                    <button
                      key={option.scope}
                      type="button"
                      className={`rounded-xl border p-3 text-left transition-colors ${
                        selected
                          ? "border-[#4d8dff]/55 bg-[#4d8dff]/10"
                          : "border-white/[0.07] bg-white/[0.02] hover:border-white/[0.13] hover:bg-white/[0.04]"
                      }`}
                      onClick={() => {
                        setShareAccessScope(option.scope);
                        setShareLink("");
                        setShareCopied(false);
                      }}
                    >
                      <span className="block text-xs font-medium text-white/80">
                        {option.label}
                      </span>
                      <span className="mt-1 block text-[11px] leading-4 text-white/35">
                        {option.description}
                      </span>
                    </button>
                  );
                })}
              </div>
              {shareAccessScope === "restricted" ? (
                <div className="space-y-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                  <label className="block text-xs text-white/45">
                    People
                    <textarea
                      className={`${field} mt-1.5 min-h-16 resize-none py-2`}
                      value={shareRecipientEmails}
                      placeholder="teammate@company.com, reviewer@company.com"
                      onChange={(event) => {
                        setShareRecipientEmails(event.target.value);
                        setShareLink("");
                        setShareCopied(false);
                      }}
                    />
                  </label>
                  <div>
                    <div className="mb-2 text-xs text-white/45">
                      Workspaces
                    </div>
                    <div className="space-y-1">
                      {organizations.map(({ organization }) => {
                        const checked = shareRecipientOrgIds.includes(
                          organization.id,
                        );
                        return (
                          <label
                            key={organization.id}
                            className="flex h-8 items-center gap-2 rounded-lg px-2 text-xs text-white/60 hover:bg-white/[0.04]"
                          >
                            <input
                              type="checkbox"
                              className="size-3 accent-[#4d8dff]"
                              checked={checked}
                              onChange={(event) => {
                                setShareRecipientOrgIds((current) =>
                                  event.target.checked
                                    ? [...current, organization.id]
                                    : current.filter(
                                        (id) => id !== organization.id,
                                      ),
                                );
                                setShareLink("");
                                setShareCopied(false);
                              }}
                            />
                            <span className="truncate">
                              {organization.displayName}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <p className="flex items-start gap-2.5 rounded-lg bg-white/[0.025] px-3.5 py-3 text-xs leading-5 text-white/40">
              <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-white/30" />
              The recipient must sign in before AO grants access.
            </p>
            <div className="space-y-3 rounded-xl border border-white/[0.07] bg-white/[0.015] p-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium text-white/50">
                  Manage access
                </div>
                {shareAccessLoading ? (
                  <LoaderCircle className="size-3.5 animate-spin text-white/35 motion-reduce:animate-none" />
                ) : null}
              </div>
              {(shareAccess?.grants.length ?? 0) > 0 ? (
                <div className="space-y-1">
                  {shareAccess?.grants.map((grant) => (
                    <div
                      key={grant.id}
                      className="flex items-center gap-2 rounded-lg bg-white/[0.025] px-2 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs text-white/75">
                          {grant.user.displayName || grant.user.email}
                        </div>
                        <div className="truncate text-[11px] text-white/30">
                          {grant.user.email}
                        </div>
                      </div>
                      <select
                        className="h-7 rounded-md border border-white/[0.08] bg-[#111317] px-2 text-xs text-white/70"
                        value={grant.role}
                        disabled={loading}
                        onChange={(event) =>
                          void updateShareGrantRole(
                            grant.id,
                            event.target.value as "viewer" | "editor",
                          )
                        }
                        aria-label={`Access for ${grant.user.email}`}
                      >
                        <option value="viewer">Viewer</option>
                        <option value="editor">Editor</option>
                      </select>
                      <button
                        type="button"
                        className="h-7 rounded-md px-2 text-xs text-white/35 hover:bg-white/[0.05] hover:text-white/70"
                        onClick={() => void revokeShareGrant(grant.id)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-white/30">
                  No one has redeemed this project yet.
                </div>
              )}
              {(shareAccess?.links.length ?? 0) > 0 ? (
                <div className="border-t border-white/[0.06] pt-3">
                  <div className="mb-2 text-[11px] uppercase tracking-[0.08em] text-white/25">
                    Active links
                  </div>
                  <div className="space-y-1">
                    {shareAccess?.links.map((link) => (
                      <div
                        key={link.id}
                        className="flex items-center gap-2 rounded-lg px-2 py-2 text-xs text-white/50"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {link.accessScope === "restricted"
                            ? `Restricted to ${
                                link.recipients?.length ?? 0
                              } recipient${(link.recipients?.length ?? 0) === 1 ? "" : "s"}`
                            : "Anyone with the link"}{" "}
                          · {link.role}
                        </span>
                        <button
                          type="button"
                          className="h-7 rounded-md px-2 text-xs text-white/35 hover:bg-white/[0.05] hover:text-white/70"
                          onClick={() => void revokeShareLink(link.id)}
                        >
                          Revoke
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            {shareLink ? (
              <div className="space-y-3 rounded-xl border border-[#4d8dff]/20 bg-[#4d8dff]/[0.06] p-3">
                <label className="block text-xs text-white/45">
                  Share link
                  <input
                    className={`${field} mt-1.5 font-mono text-[11px]`}
                    value={shareLink}
                    readOnly
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </label>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className={button}
                    onClick={() => {
                      void navigator.clipboard.writeText(shareLink).then(() => {
                        setShareCopied(true);
                      });
                    }}
                  >
                    <Copy className="size-3.5" />
                    {shareCopied ? "Copied" : "Copy link"}
                  </button>
                  <button type="button" className={primaryButton} onClick={closeProjectShare}>
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <div className="-mx-5 -mb-5 flex justify-end gap-2 border-t border-white/[0.07] px-5 py-4 sm:-mx-6 sm:-mb-6 sm:px-6">
                <button type="button" className={button} onClick={closeProjectShare}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={primaryButton}
                  disabled={loading}
                  onClick={() => void createProjectShareLink()}
                >
                  <ExternalLink className="size-3.5" />
                  Create link
                </button>
              </div>
            )}
          </div>
        </Overlay>
      ) : null}
      {showSessionForm && selectedOrgId && !selectedShare && selectedProjectId && (
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
  scmBySessionId = {},
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
  scmBySessionId?: Record<string, CloudSessionSCM | null>;
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
              <CloudBoardSessionCard
                key={cloudSession.id}
                session={cloudSession}
                project={projects.find(({ id }) => id === cloudSession.projectId)}
                scm={scmBySessionId[cloudSession.id]}
                displayStatus={sessionDisplayStatus(
                  cloudSession,
                  activeSessionIds,
                )}
                onOpen={() => onSelect(cloudSession)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function CloudBoardSessionCard({
  session,
  project,
  scm,
  displayStatus,
  onOpen,
}: {
  session: CloudSession;
  project?: CloudProject;
  scm?: CloudSessionSCM | null;
  displayStatus: CloudSession["status"];
  onOpen: () => void;
}) {
  const status = cloudStatusView(displayStatus);
  const pullRequest = scm?.pullRequest;
  const unresolvedThreads =
    scm?.reviewThreads?.filter((thread) => !thread.isResolved && !thread.isOutdated)
      .length ?? 0;
  const showBranch =
    session.branch &&
    session.branch !== session.displayName &&
    session.branch !== session.id;
  return (
    <button
      className={`group w-full rounded-lg border bg-[#15171b] text-left transition-[border-color,box-shadow] hover:border-white/10 hover:shadow-sm ${status.cardClassName}`}
      onClick={onOpen}
      data-testid="cloud-board-session-card"
    >
      <div className="flex items-start gap-2.5 px-3.5 pb-2.5 pt-3">
        {session.kind === "orchestrator" ? (
          <OrchestratorIcon className="mt-0.5 size-[18px] shrink-0 text-[#9ba1aa]" />
        ) : (
          <AgentAvatar agent={session.harness} className="mt-0.5 size-[18px]" />
        )}
        <div className="min-w-0 flex-1">
          <div
            className="line-clamp-2 overflow-hidden text-sm font-semibold leading-tight tracking-[-0.01em] text-[#f4f5f7]"
            title={session.displayName}
          >
            {session.displayName}
          </div>
          {showBranch ? (
            <div className="mt-1.5 flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-[#646a73]">
              <GitBranch className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{session.branch}</span>
            </div>
          ) : null}
        </div>
      </div>
      <div aria-hidden="true" className="mx-3.5 my-px h-px bg-white/[0.08]" />
      <div className="flex flex-col gap-1.5 px-3.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <span
            className={`inline-flex min-w-0 items-center gap-1.5 truncate text-[11px] font-medium ${status.className}`}
          >
            {displayStatus === "working" ? (
              <LoaderCircle
                className="size-3 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <span className="size-1.5 shrink-0 rounded-full bg-current" />
            )}
            {status.label}
          </span>
          <span
            className="shrink-0 whitespace-nowrap font-mono text-[10px] text-[#646a73]"
            title={session.createdAt}
          >
            {formatCloudTime(session.createdAt)}
          </span>
        </div>
        {pullRequest ? (
          <div className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-[#9ba1aa]">
            <GitPullRequest className="size-3 shrink-0 text-[#5b8def]" />
            <span className="min-w-0 flex-1 truncate">
              #{pullRequest.number} {pullRequest.title || pullRequest.repository}
            </span>
            <span className="shrink-0 uppercase text-[#646a73]">
              {pullRequestLabel(pullRequest)}
            </span>
          </div>
        ) : (
          <div className="font-mono text-[10px] text-[#646a73]">no PR yet</div>
        )}
        <div className="flex min-w-0 items-center gap-2 font-mono text-[10px] text-[#646a73]">
          <span className="min-w-0 flex-1 truncate">
            {project?.displayName ?? "Unknown project"}
          </span>
          <span className="shrink-0 uppercase tracking-[0.04em]">
            {session.runtimeConnected ? "runtime live" : "runtime starting"}
          </span>
        </div>
        {unresolvedThreads > 0 ? (
          <span className="inline-flex max-w-full items-center self-start truncate rounded-sm bg-[#e8c14a]/12 px-1.5 py-0.5 font-mono text-[9px] uppercase text-[#e8c14a]">
            {unresolvedThreads} unresolved review{" "}
            {unresolvedThreads === 1 ? "thread" : "threads"}
          </span>
        ) : null}
      </div>
    </button>
  );
}

function cloudStatusView(status: CloudSession["status"]) {
  switch (status) {
    case "needs_input":
      return {
        label: "Needs input",
        className: "text-[#e8c14a]",
        cardClassName: "border-[#e8c14a]/20",
      };
    case "ci_failed":
      return {
        label: "CI failed",
        className: "text-[#ef6b6b]",
        cardClassName: "border-[#ef6b6b]/20",
      };
    case "changes_requested":
      return {
        label: "Changes requested",
        className: "text-[#e8c14a]",
        cardClassName: "border-[#e8c14a]/20",
      };
    case "pr_open":
      return {
        label: "PR open",
        className: "text-[#5b8def]",
        cardClassName: "border-[#5b8def]/20",
      };
    case "review_pending":
      return {
        label: "Review pending",
        className: "text-[#5b8def]",
        cardClassName: "border-[#5b8def]/20",
      };
    case "approved":
      return {
        label: "Approved",
        className: "text-[#74b98a]",
        cardClassName: "border-[#74b98a]/20",
      };
    case "mergeable":
      return {
        label: "Ready to merge",
        className: "text-[#74b98a]",
        cardClassName: "border-[#74b98a]/20",
      };
    case "merged":
      return {
        label: "Merged",
        className: "text-[#74b98a]",
        cardClassName: "border-[#74b98a]/20",
      };
    case "working":
      return {
        label: "Working",
        className: "text-[#f59f4c]",
        cardClassName: "border-[#f59f4c]/20",
      };
    case "terminated":
    case "exited":
      return {
        label: "Exited",
        className: "text-[#646a73]",
        cardClassName: "border-white/[0.06]",
      };
    case "idle":
    default:
      return {
        label: "Idle",
        className: "text-[#9ba1aa]",
        cardClassName: "border-white/[0.06]",
      };
  }
}

function pullRequestLabel(pullRequest: CloudSessionSCM["pullRequest"]) {
  if (!pullRequest) return "";
  if (pullRequest.state === "merged") return "merged";
  if (pullRequest.ciState === "failure") return "ci failed";
  if (pullRequest.reviewState === "changes_requested") return "changes";
  if (pullRequest.mergeability === "mergeable") return "mergeable";
  if (pullRequest.reviewState === "approved") return "approved";
  if (pullRequest.draft) return "draft";
  return pullRequest.state || "open";
}

function formatCloudTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function CloudSettings({
  api,
  currentUser,
  organizations,
  selectedOrg,
  selectedOrgId,
  onBack,
  onSelectOrg,
  incomingInvitations,
  orgInvitations,
  orgMembers,
  connections,
  githubConnection,
  agentCredentialsMode,
  sandboxProvider,
  initialPanel,
  run,
  loading,
}: {
  api: CloudAPI;
  currentUser: CloudUser | null;
  organizations: CloudUserOrganization[];
  selectedOrg?: CloudUserOrganization;
  selectedOrgId: string | null;
  onBack: () => void;
  onSelectOrg: (orgId: string) => void;
  incomingInvitations: CloudOrgInvitation[];
  orgInvitations: CloudOrgInvitation[];
  orgMembers: CloudOrgMember[];
  connections: ProviderConnection[];
  githubConnection: CloudGitHubConnection | null;
  agentCredentialsMode: AgentCredentialsMode;
  sandboxProvider: "daytona" | "fly";
  initialPanel: "profile" | "notifications" | "createOrg" | "org" | "agents" | "sandbox";
  run: (operation: () => Promise<unknown>) => Promise<unknown>;
  loading: boolean;
}) {
  const [apiKey, setAPIKey] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member" | "viewer">(
    "member",
  );
  const [profileName, setProfileName] = useState(
    currentUser?.displayName ?? "",
  );
  const [settingsPanel, setSettingsPanel] = useState<
    "profile" | "notifications" | "createOrg" | "org" | "agents" | "sandbox"
  >(() =>
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("settings") === "github"
      ? "agents"
      : "org",
  );
  useEffect(() => {
    setSettingsPanel(initialPanel);
  }, [initialPanel]);
  const [orgName, setOrgName] = useState(
    selectedOrg?.organization.displayName ?? "",
  );
  const [newOrgName, setNewOrgName] = useState("");
  const [target, setTarget] = useState<"us" | "eu">("us");
  useEffect(() => {
    setOrgName(selectedOrg?.organization.displayName ?? "");
  }, [selectedOrg?.organization.displayName]);
  useEffect(() => {
    setProfileName(currentUser?.displayName ?? "");
  }, [currentUser?.displayName]);
  const canAdminOrg =
    selectedOrg?.membership.role === "owner" ||
    selectedOrg?.membership.role === "admin";
  const canEditOrgName = canAdminOrg;
  const pendingOrgInvitations = orgInvitations.filter(
    (invitation) => invitation.status === "pending",
  );
  const pendingIncomingInvitations = incomingInvitations.filter(
    (invitation) => invitation.status === "pending",
  );
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
    <div className="grid h-full min-h-0 grid-cols-[240px_minmax(0,1fr)] bg-[#0a0b0d]">
      <nav className="min-h-0 overflow-auto border-r border-white/[0.08] bg-[#111216] p-3">
        <button
          type="button"
          className="mb-4 flex h-8 items-center gap-2 rounded-md px-2 text-sm text-white/45 hover:bg-white/[0.04] hover:text-white"
          onClick={onBack}
        >
          {"<"} Back to app
        </button>
        <div className="mb-4 flex h-8 items-center gap-2 rounded-md border border-white/[0.08] bg-[#0c0d10] px-2 text-sm text-white/45">
          <span className="size-1.5 rounded-full bg-white/25" />
          Search settings
        </div>
        <div className="space-y-5">
          <div>
            <p className="px-2 font-mono text-[10px] uppercase tracking-[0.08em] text-white/35">
              Personal
            </p>
            <div className="mt-1 space-y-0.5">
              <SettingsNavItem
                active={settingsPanel === "profile"}
                icon={User}
                label="Profile"
                onClick={() => setSettingsPanel("profile")}
              />
              <SettingsNavItem
                icon={Bell}
                label="Notifications"
                active={settingsPanel === "notifications"}
                badge={pendingIncomingInvitations.length}
                onClick={() => setSettingsPanel("notifications")}
              />
            </div>
          </div>
          <div>
            <div className="flex items-center px-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-white/35">
                Organizations
              </p>
              <span className="ml-auto font-mono text-[10px] text-white/25">
                {organizations.length}
              </span>
            </div>
            <div className="mt-1 space-y-0.5">
              <button
                type="button"
                className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${
                  settingsPanel === "createOrg"
                    ? "bg-white/[0.08] text-white"
                    : "text-white/55 hover:bg-white/[0.04] hover:text-white"
                }`}
                onClick={() => setSettingsPanel("createOrg")}
              >
                <Plus className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Add organization</span>
              </button>
              {organizations.map(({ organization, membership }) => (
                <button
                  key={organization.id}
                  type="button"
                  className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${
                    settingsPanel === "org" && organization.id === selectedOrgId
                      ? "bg-white/[0.08] text-white"
                      : "text-white/55 hover:bg-white/[0.04] hover:text-white"
                  }`}
                  onClick={() => {
                    onSelectOrg(organization.id);
                    setSettingsPanel("org");
                  }}
                >
                  <Building2 className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {organization.displayName}
                  </span>
                  <span className="font-mono text-[9px] uppercase text-white/30">
                    {membership.role}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="px-2 font-mono text-[10px] uppercase tracking-[0.08em] text-white/35">
              Admin
            </p>
            <div className="mt-1 space-y-0.5">
              <SettingsNavItem
                active={settingsPanel === "agents"}
                icon={KeyRound}
                label="Provider connections"
                onClick={() => setSettingsPanel("agents")}
              />
              <SettingsNavItem
                active={settingsPanel === "sandbox"}
                icon={Cloud}
                label="Sandbox provider"
                onClick={() => setSettingsPanel("sandbox")}
              />
            </div>
          </div>
        </div>
      </nav>
      <div className="min-h-0 overflow-auto p-8">
        <div className="mx-auto max-w-3xl space-y-10">
          <section>
            <h2 className="text-base font-medium">{settingsTitle(settingsPanel)}</h2>
            <p className="mt-1 text-sm leading-6 text-white/45">
              {settingsDescription(settingsPanel)}
            </p>
          </section>
          {settingsPanel === "profile" ? (
          <SettingsPanel
            title="Profile"
            description="This name is shown in local AO Cloud workspace switchers, invitations, and future team activity."
          >
            <form
              className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() =>
                  api.updateProfile({ displayName: profileName }),
                );
              }}
            >
              <label className="text-xs text-white/45">
                Name
                <input
                  className={`${field} mt-1.5`}
                  value={profileName}
                  onChange={(event) => setProfileName(event.target.value)}
                  placeholder="Your name"
                  maxLength={120}
                  required
                />
              </label>
              <button
                type="submit"
                className={`${button} self-end`}
                disabled={
                  loading ||
                  profileName.trim() === "" ||
                  profileName.trim() === (currentUser?.displayName ?? "")
                }
              >
                Save profile
              </button>
              <p className="sm:col-span-2 text-xs leading-5 text-white/35">
                Email is used for login and invitations:{" "}
                <span className="text-white/55">
                  {currentUser?.email ?? "Unknown email"}
                </span>
              </p>
            </form>
          </SettingsPanel>
          ) : null}
          {settingsPanel === "createOrg" ? (
          <SettingsPanel title="Create organization" description="Create a new AO Cloud workspace with you as owner.">
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const created = await api.createOrganization({
                    displayName: newOrgName,
                  });
                  onSelectOrg(created.organization.organization.id);
                  onBack();
                }).then(() => setNewOrgName(""));
              }}
            >
              <input
                className={field}
                value={newOrgName}
                onChange={(event) => setNewOrgName(event.target.value)}
                placeholder="New workspace name"
                required
              />
              <button type="submit" className={primaryButton} disabled={loading}>
                Create
              </button>
            </form>
          </SettingsPanel>
          ) : null}
          {settingsPanel === "notifications" ? (
            <SettingsPanel
              title="Invitations for you"
              description="Accepting an invitation adds this account to that organization."
            >
              {pendingIncomingInvitations.length > 0 ? (
              <div className="space-y-2">
                {pendingIncomingInvitations.map((invitation) => (
                  <div
                    key={invitation.id}
                    className="flex items-center gap-3 rounded-lg border border-[#4d8dff]/25 bg-[#4d8dff]/10 px-3 py-2 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-white/85">
                        {invitation.email} as {invitation.role}
                      </p>
                      <p className="truncate text-xs text-white/40">
                        Invited by{" "}
                        {invitation.invitedByName ||
                          invitation.invitedByEmail ||
                          "another member"}
                      </p>
                    </div>
                    <InviteStatus status={invitation.status} />
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
              ) : (
                <p className="text-sm text-white/35">No pending invitations.</p>
              )}
            </SettingsPanel>
          ) : null}
          {settingsPanel === "org" ? (
          <SettingsPanel
            title={selectedOrg?.organization.displayName ?? "No organization selected"}
            description={`AO Cloud scopes projects, provider connections, workers, and invitations to this organization. Your role is ${selectedOrg?.membership.role ?? "viewer"}.`}
          >
            {selectedOrg && selectedOrgId ? (
              <div className="space-y-6">
                <form
                  className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(() =>
                      api.updateOrganization(selectedOrgId, {
                        displayName: orgName,
                      }),
                    );
                  }}
                >
                  <label className="text-xs text-white/45">
                    Organization name
                    <input
                      className={`${field} mt-1.5`}
                      value={orgName}
                      onChange={(event) => setOrgName(event.target.value)}
                      disabled={!canEditOrgName}
                    />
                  </label>
                  <button
                    type="submit"
                    className={`${button} self-end`}
                    disabled={!canEditOrgName || loading || orgName.trim() === selectedOrg.organization.displayName}
                  >
                    Save
                  </button>
                </form>
                {!canEditOrgName ? (
                  <p className="text-xs leading-5 text-white/35">
                    Organization names can be edited by owners and admins.
                  </p>
                ) : null}
                <div className="border-y border-white/[0.08] py-4">
                  <div className="flex items-start gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-white/85">Coding agent credentials</p>
                      <p className="mt-1 text-xs leading-5 text-white/40">
                        {selectedOrg.organization.kind === "personal"
                          ? "This personal workspace is the default credential source for organizations that inherit your keys."
                          : "Choose whether this organization inherits your personal API keys or keeps separate keys."}
                      </p>
                    </div>
                    <button
                      type="button"
                      className={button}
                      onClick={() => setSettingsPanel("agents")}
                    >
                      Manage keys
                    </button>
                  </div>
                  {selectedOrg.organization.kind === "personal" ? (
                    <div className="mt-3 flex items-center justify-between rounded-lg border border-[#4d8dff]/35 bg-[#4d8dff]/[0.08] px-3 py-2">
                      <div>
                        <p className="text-sm text-white/80">Personal default</p>
                        <p className="mt-0.5 text-xs text-white/40">
                          Keys saved here can be inherited by your other organizations.
                        </p>
                      </div>
                      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#7ba8ff]">
                        Default
                      </span>
                    </div>
                  ) : (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {[
                        {
                          value: "personal_default" as const,
                          title: "Use personal default",
                          description: "Inherit keys from your personal workspace.",
                        },
                        {
                          value: "custom" as const,
                          title: "Use separate org keys",
                          description: "Keep credentials owned only by this organization.",
                        },
                      ].map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                            agentCredentialsMode === option.value
                              ? "border-[#4d8dff]/45 bg-[#4d8dff]/10 text-white"
                              : "border-white/10 bg-[#0f1115] text-white/55 hover:border-white/20 hover:text-white"
                          }`}
                          disabled={
                            !canAdminOrg ||
                            loading ||
                            agentCredentialsMode === option.value
                          }
                          onClick={() =>
                            void run(() =>
                              api.updateProviderSettings(selectedOrgId, {
                                agentCredentialsMode: option.value,
                              }),
                            )
                          }
                        >
                          <span className="block text-sm">{option.title}</span>
                          <span className="mt-1 block text-xs leading-5 text-white/40">
                            {option.description}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {!canAdminOrg ? (
                    <p className="mt-2 text-xs text-white/35">
                      Only owners and admins can change the credential source.
                    </p>
                  ) : null}
                </div>
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <p className="text-sm text-white/85">Members</p>
                    <span className="ml-auto font-mono text-[10px] uppercase text-white/35">
                      {orgMembers.length} active
                    </span>
                  </div>
                  <div className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.08] bg-[#111317]">
                    {orgMembers.length > 0 ? (
                      orgMembers.map((member) => (
                        <div
                          key={member.membership.id}
                          className="flex items-center gap-3 px-3 py-2 text-sm"
                        >
                          <div className="grid size-7 shrink-0 place-items-center rounded-md border border-white/[0.08] bg-[#1a1c22] text-[11px] uppercase text-white/55">
                            {(member.user.displayName || member.user.email).charAt(0)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-white/80">
                              {member.user.displayName || member.user.email}
                            </p>
                            <p className="truncate text-xs text-white/35">
                              {member.user.email}
                            </p>
                          </div>
                          <select
                            className="h-8 rounded-md border border-white/[0.08] bg-[#0c0d10] px-2 text-xs text-white outline-none focus:border-[#4d8dff] disabled:opacity-45"
                            value={member.membership.role}
                            disabled={
                              !canAdminOrg ||
                              loading ||
                              member.user.id === currentUser?.id
                            }
                            aria-label={`Role for ${member.user.email}`}
                            onChange={(event) => {
                              if (!selectedOrgId) return;
                              const role = event.target
                                .value as CloudOrgMembership["role"];
                              void run(() =>
                                api.updateOrgMemberRole(
                                  selectedOrgId,
                                  member.user.id,
                                  { role },
                                ),
                              );
                            }}
                          >
                            <option value="owner">Owner</option>
                            <option value="admin">Admin</option>
                            <option value="member">Member</option>
                            <option value="viewer">Viewer</option>
                          </select>
                        </div>
                      ))
                    ) : (
                      <p className="px-3 py-3 text-sm text-white/35">
                        No active members were found for this organization.
                      </p>
                    )}
                  </div>
                </div>
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <p className="text-sm text-white/85">Invitations</p>
                    <span className="ml-auto font-mono text-[10px] uppercase text-white/35">
                      {pendingOrgInvitations.length} pending
                    </span>
                  </div>
                  <div className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.08] bg-[#111317]">
                    {orgInvitations.length > 0 ? (
                      orgInvitations.map((invitation) => (
                        <div
                          key={invitation.id}
                          className="flex items-center gap-3 px-3 py-2 text-sm"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-white/80">
                              {invitation.email}
                            </p>
                            <p className="truncate text-xs text-white/35">
                              Invited by{" "}
                              {invitation.invitedByName ||
                                invitation.invitedByEmail ||
                                "unknown"}{" "}
                              · {invitation.role}
                            </p>
                          </div>
                          <InviteStatus status={invitation.status} />
                          {canAdminOrg && invitation.status === "pending" ? (
                            <button
                              type="button"
                              className={button}
                              onClick={() =>
                                void run(() =>
                                  api.revokeInvitation(
                                    selectedOrgId,
                                    invitation.id,
                                  ),
                                )
                              }
                            >
                              Revoke
                            </button>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <p className="px-3 py-3 text-sm text-white/35">
                        No invitations have been sent for this organization.
                      </p>
                    )}
                  </div>
                  {canAdminOrg ? (
                    <form
                      className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_130px_auto]"
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
                  ) : (
                    <p className="mt-3 text-sm text-white/35">
                      Only owners and admins can invite teammates.
                    </p>
                  )}
                </div>
              </div>
            ) : null}
          </SettingsPanel>
          ) : null}
          {settingsPanel === "agents" ? (
          <div className="space-y-8">
            <GitHubConnectionSettings
              api={api}
              connection={githubConnection}
              orgId={selectedOrgId}
              canAdmin={canAdminOrg}
              loading={loading}
              run={run}
            />
            <SettingsPanel
              title="Coding agents"
              description="Credentials are encrypted in AO Cloud and delivered only to authenticated workers during bootstrap."
            >
              {selectedOrgId && selectedOrg?.organization.kind === "personal" ? (
                <div className="mb-4 flex items-center justify-between rounded-lg border border-[#4d8dff]/35 bg-[#4d8dff]/[0.08] px-3 py-2">
                  <div>
                    <p className="text-sm text-white/80">Personal default</p>
                    <p className="mt-0.5 text-xs text-white/40">
                      These keys are the default for organizations that inherit your credentials.
                    </p>
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#7ba8ff]">
                    Default
                  </span>
                </div>
              ) : null}
              {canAdminOrg && selectedOrgId && selectedOrg?.organization.kind !== "personal" ? (
                <div className="mb-4 rounded-lg border border-white/10 bg-[#15171b] p-3">
                  <p className="text-sm font-medium text-white/80">API key source</p>
                  <p className="mt-1 text-xs leading-5 text-white/40">
                    Use your personal workspace credentials as this org&apos;s default,
                    or switch to credentials owned by this organization.
                  </p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {[
                      {
                        value: "personal_default" as const,
                        title: "Use personal default",
                        description: "Sync from your personal provider keys.",
                      },
                      {
                        value: "custom" as const,
                        title: "Use org custom keys",
                        description: "Keep separate credentials for this org.",
                      },
                    ].map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                          agentCredentialsMode === option.value
                            ? "border-[#4d8dff]/45 bg-[#4d8dff]/10 text-white"
                            : "border-white/10 bg-[#0f1115] text-white/55 hover:border-white/20 hover:text-white"
                        }`}
                        disabled={loading || agentCredentialsMode === option.value}
                        onClick={() =>
                          void run(() =>
                            api.updateProviderSettings(selectedOrgId, {
                              agentCredentialsMode: option.value,
                            }),
                          )
                        }
                      >
                        <span className="block text-sm">{option.title}</span>
                        <span className="mt-1 block text-xs leading-5 text-white/40">
                          {option.description}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {canAdminOrg && selectedOrgId ? (
                <div className="divide-y divide-white/10 border-y border-white/10">
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
                <div className="rounded-lg border border-white/10 bg-[#15171b] px-3 py-2 text-sm text-white/45">
                  Coding-agent connections are read-only for your organization role.
                </div>
              )}
            </SettingsPanel>
          </div>
          ) : null}
          {settingsPanel === "sandbox" ? (
          <SettingsPanel
            title={sandboxProvider === "fly" ? "Fly Machines" : "Daytona"}
            description={
              sandboxProvider === "fly"
                ? "AO Cloud provisions one isolated Fly Machine and persistent volume per session."
                : "Credentials are validated by AO Cloud, encrypted outside session environments, and never returned to this browser."
            }
          >
            {!canAdminOrg || !selectedOrgId ? (
              <p className="text-sm leading-6 text-white/45">
                Only organization admins can change sandbox provider settings.
              </p>
            ) : sandboxProvider === "fly" ? (
              <div className="flex items-center rounded-lg border border-white/10 bg-[#15171b] px-3 py-2 text-sm">
                <span>Deployment-managed connection</span>
                <span className="ml-auto font-mono text-[10px] uppercase text-[#9ad97a]">
                  Active
                </span>
              </div>
            ) : (
              <>
                {daytonaConnections.map((connection) => (
                  <div
                    key={connection.id}
                    className="mb-3 flex items-center border border-white/10 bg-[#15171b] px-3 py-2 text-sm"
                  >
                    <span>{connection.label}</span>
                    <span className="ml-auto font-mono text-[10px] uppercase text-[#74b98a]">
                      {connection.validationState}
                    </span>
                  </div>
                ))}
                <form
                  className="space-y-3"
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
              </>
            )}
          </SettingsPanel>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function gitHubInstallationSettingsURL(
  installation: CloudGitHubInstallation,
) {
  const id = encodeURIComponent(installation.githubInstallationId);
  if (installation.accountType.toLowerCase() === "organization") {
    return `https://github.com/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${id}`;
  }
  return `https://github.com/settings/installations/${id}`;
}

export function GitHubConnectionSettings({
  api,
  connection,
  orgId,
  canAdmin,
  loading,
  run,
}: {
  api: CloudAPI;
  connection: CloudGitHubConnection | null;
  orgId: string | null;
  canAdmin: boolean;
  loading: boolean;
  run: (operation: () => Promise<unknown>) => Promise<unknown>;
}) {
  const activeInstallations =
    connection?.installations.filter(
      (installation) => installation.status === "active",
    ) ?? [];
  const repositoryCount = connection?.repositories.length ?? 0;

  return (
    <SettingsPanel
      title="GitHub"
      description="Controls which repositories this organization can use for cloud projects."
    >
      {!connection ? (
        <div className="flex items-center gap-2 text-sm text-white/45" role="status">
          <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
          Loading GitHub connection…
        </div>
      ) : connection.mode === "local-gh" ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <Github className="mt-0.5 size-4 shrink-0 text-white/70" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-white/85">Host GitHub CLI</p>
              <p className="mt-0.5 text-xs leading-5 text-white/40">
                Authentication is managed locally with <code>gh auth</code>. GitHub App
                installation controls are unavailable in this mode.
              </p>
            </div>
            <span className="font-mono text-[10px] uppercase text-[#74b98a]">
              Managed locally
            </span>
          </div>
          <RepositoryGrants repositories={connection.repositories} />
        </div>
      ) : connection.mode === "disabled" ? (
        <div className="flex items-start gap-3">
          <Github className="mt-0.5 size-4 shrink-0 text-white/35" />
          <div>
            <p className="text-sm text-white/70">GitHub is disabled</p>
            <p className="mt-1 text-xs leading-5 text-white/40">
              This AO Cloud deployment has no GitHub connection configured.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.08] pb-4">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <Github className="size-4 shrink-0 text-white/70" />
              <div className="min-w-0">
                <p className="truncate text-sm text-white/85">
                  {activeInstallations.length > 0
                    ? `${activeInstallations.length} connected account${activeInstallations.length === 1 ? "" : "s"}`
                    : "GitHub App not connected"}
                </p>
                <p className="mt-0.5 text-xs text-white/40">
                  {repositoryCount} granted repositor{repositoryCount === 1 ? "y" : "ies"}
                  {connection.appSlug ? ` · ${connection.appSlug}` : ""}
                </p>
              </div>
            </div>
            {canAdmin && orgId ? (
              <button
                type="button"
                className={activeInstallations.length > 0 ? button : primaryButton}
                disabled={loading}
                onClick={() =>
                  void run(async () => {
                    const { installUrl } = await api.startGitHubInstall(orgId);
                    window.location.assign(installUrl);
                  })
                }
              >
                {activeInstallations.length > 0 ? "Connect another" : "Connect GitHub"}
              </button>
            ) : (
              <span className="font-mono text-[10px] uppercase text-white/35">
                Read only
              </span>
            )}
          </div>

          {connection.installations.length > 0 ? (
            <div className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.08] bg-[#111317]">
              {connection.installations.map((installation) => (
                <div
                  key={installation.id}
                  className="flex flex-wrap items-center gap-3 px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-white/80">
                      {installation.accountLogin}
                    </p>
                    <p className="mt-0.5 text-xs text-white/35">
                      {installation.accountType} · {installation.repositorySelection} access
                    </p>
                  </div>
                  <span
                    className={`font-mono text-[10px] uppercase ${
                      installation.status === "active"
                        ? "text-[#74b98a]"
                        : "text-white/35"
                    }`}
                  >
                    {installation.status}
                  </span>
                  {canAdmin && orgId && installation.status === "active" ? (
                    <div className="flex items-center gap-1">
                      <a
                        className={button}
                        href={gitHubInstallationSettingsURL(installation)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Configure
                        <ExternalLink className="size-3" />
                      </a>
                      <button
                        type="button"
                        className={button}
                        disabled={loading}
                        onClick={() =>
                          void run(() => api.syncGitHub(orgId))
                        }
                      >
                        <RefreshCw className="size-3" />
                        Sync
                      </button>
                      <button
                        type="button"
                        className={`${button} text-[#ef9b9b] hover:bg-[#ef6b6b]/10`}
                        disabled={loading}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Disconnect GitHub account ${installation.accountLogin}? Cloud projects will no longer be able to use its repository grants.`,
                            )
                          ) {
                            return;
                          }
                          void run(() =>
                            api.disconnectGitHubInstallation(
                              orgId,
                              installation.githubInstallationId,
                            ),
                          );
                        }}
                      >
                        Disconnect
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm leading-6 text-white/40">
              {canAdmin
                ? "Connect the GitHub App to grant this organization access to repositories."
                : "An organization owner or admin must connect the GitHub App."}
            </p>
          )}

          <RepositoryGrants repositories={connection.repositories} />
        </div>
      )}
    </SettingsPanel>
  );
}

function RepositoryGrants({
  repositories,
}: {
  repositories: CloudGitHubGrantedRepository[];
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <p className="text-xs text-white/55">Repository grants</p>
        <span className="ml-auto font-mono text-[10px] uppercase text-white/30">
          {repositories.length}
        </span>
      </div>
      {repositories.length > 0 ? (
        <div className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.08] bg-[#111317]">
          {repositories.map((repository) => (
            <a
              key={repository.repository.id}
              href={repository.repository.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 px-3 py-2 text-sm text-white/70 transition-colors hover:bg-white/[0.03] hover:text-white"
            >
              <FolderGit2 className="size-3.5 shrink-0 text-white/40" />
              <span className="min-w-0 flex-1 truncate">
                {repository.repository.fullName}
              </span>
              {repository.repository.private ? (
                <span className="font-mono text-[9px] uppercase text-white/30">
                  Private
                </span>
              ) : null}
              <ExternalLink className="size-3 shrink-0 text-white/25" />
            </a>
          ))}
        </div>
      ) : (
        <p className="text-xs leading-5 text-white/35">
          No repositories are currently granted.
        </p>
      )}
    </div>
  );
}

function SettingsNavItem({
  active,
  icon: Icon,
  label,
  badge,
  onClick,
}: {
  active?: boolean;
  icon: typeof Settings;
  label: string;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${
        active
          ? "bg-white/[0.08] text-white"
          : "text-white/55 hover:bg-white/[0.04] hover:text-white"
      }`}
      onClick={onClick}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge ? (
        <span className="rounded-full bg-[#4d8dff] px-1.5 font-mono text-[9px] text-white">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function settingsTitle(
  panel: "profile" | "notifications" | "createOrg" | "org" | "agents" | "sandbox",
) {
  switch (panel) {
    case "profile":
      return "Profile";
    case "notifications":
      return "Notifications";
    case "createOrg":
      return "Add organization";
    case "agents":
      return "Provider connections";
    case "sandbox":
      return "Sandbox provider";
    case "org":
    default:
      return "Organization settings";
  }
}

function settingsDescription(
  panel: "profile" | "notifications" | "createOrg" | "org" | "agents" | "sandbox",
) {
  switch (panel) {
    case "profile":
      return "Manage how your account appears in local AO Cloud.";
    case "notifications":
      return "Review invitations and account-level notices.";
    case "createOrg":
      return "Create a team workspace that can own projects, workers, and credentials.";
    case "agents":
      return "Manage coding-agent credentials for the selected organization.";
    case "sandbox":
      return "Manage sandbox provider credentials for the selected organization.";
    case "org":
    default:
      return "Manage the selected organization, invitations, and role-aware permissions.";
  }
}

function SettingsPanel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3">
        <h3 className="text-sm font-medium text-white">{title}</h3>
        <p className="mt-1 text-sm leading-5 text-white/40">{description}</p>
      </div>
      <div className="rounded-xl border border-white/[0.08] bg-[#15171b] p-4">
        {children}
      </div>
    </section>
  );
}

function InviteStatus({ status }: { status: CloudOrgInvitation["status"] }) {
  const color =
    status === "accepted"
      ? "text-[#74b98a]"
      : status === "declined" || status === "revoked"
        ? "text-[#ef6b6b]"
        : "text-[#e8c14a]";
  return (
    <span className={`font-mono text-[10px] uppercase ${color}`}>
      {status}
    </span>
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
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#050608]/75 p-4 backdrop-blur-[2px] sm:p-6">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[min(760px,calc(100dvh-2rem))] w-full max-w-lg overflow-y-auto rounded-xl border border-white/[0.12] bg-[#0f1013] shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
      >
        <header className="flex h-14 items-center border-b border-white/[0.08] px-5 sm:px-6">
          <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-white/80">
            {title}
          </h2>
          <button
            className="ml-auto grid size-8 place-items-center rounded-lg text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d8dff]/70"
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
  githubConnection,
  loading,
  onOpenGitHubSettings,
  onClose,
  onSubmit,
}: {
  repositories: CloudRepository[];
  repositoriesLoading: boolean;
  repositoriesError: string | null;
  githubConnection: CloudGitHubConnection | null;
  loading: boolean;
  onOpenGitHubSettings: () => void;
  onClose: () => void;
  onSubmit: (input: {
    displayName: string;
    repositoryUrl: string;
    defaultBranch: string;
    githubRepositoryId?: number;
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
  const hasActiveGitHubAppInstallation =
    githubConnection?.mode === "github-app" &&
    githubConnection.installations.some(
      (installation) => installation.status === "active",
    );
  const showRepositorySelect = repositoriesLoading || repositories.length > 0;
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
            githubRepositoryId: selected.id,
          });
        }}
      >
        {showRepositorySelect ? (
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
        ) : null}
        {repositoriesLoading ? (
          <p className="text-sm text-muted-foreground">
            Loading GitHub repositories…
          </p>
        ) : repositoriesError ? (
          <p className="text-sm text-destructive">{repositoriesError}</p>
        ) : null}
        {!repositoriesLoading && repositories.length === 0 ? (
          <div className="rounded-lg border border-[#e8c14a]/20 bg-[#e8c14a]/[0.06] px-3 py-2.5">
            <p className="text-sm text-[#e8c14a]">
              {hasActiveGitHubAppInstallation
                ? "No repositories are granted to this organization."
                : "GitHub not connected."}
            </p>
            <p className="mt-1 text-xs leading-5 text-white/45">
              Connect GitHub from Provider connections to choose a repository for
              this project.
            </p>
            <button
              type="button"
              className="mt-2 text-xs text-[#8eb6ff] hover:underline"
              onClick={onOpenGitHubSettings}
            >
              Connect GitHub in Settings
            </button>
          </div>
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
