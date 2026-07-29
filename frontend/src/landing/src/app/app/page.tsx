"use client";

import {
  Cloud,
  FolderGit2,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Pause,
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
  useState,
  type SVGProps,
} from "react";

import {
  CloudAPI,
  type AgentCredentialType,
  type CloudAgent,
  type CloudProject,
  type CloudRepository,
  type CloudSession,
  type ProviderConnection,
} from "@/lib/cloud-api";
import {
  CLOUD_AGENTS,
  connectedAgentIDs,
  defaultConnectedAgent,
} from "@/lib/cloud-agent-connections";
import { useAuth } from "../auth/AuthProvider";
import { CloudTerminal } from "./CloudTerminal";

type View = "board" | "session" | "settings";

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
  if (session.status === "working") return "bg-[#36c2b4]";
  if (session.status === "pr_open" || session.status === "review_pending")
    return "bg-[#5b8def]";
  return "bg-[#9ad97a]";
}

export default function CloudAppPage() {
  const { session, status, login, logout } = useAuth();
  const api = useMemo(
    () => (session?.access_token ? new CloudAPI(session.access_token) : null),
    [session?.access_token],
  );
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [sessions, setSessions] = useState<CloudSession[]>([]);
  const [repositories, setRepositories] = useState<CloudRepository[]>([]);
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [sandboxProvider, setSandboxProvider] = useState<"daytona" | "fly">(
    "daytona",
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [view, setView] = useState<View>("board");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showSessionForm, setShowSessionForm] = useState(false);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const [
        projectData,
        sessionData,
        repositoryData,
        connectionData,
        runtimeData,
      ] = await Promise.all([
        api.projects(),
        api.sessions(),
        api.repositories(),
        api.providerConnections(),
        api.me(),
      ]);
      setProjects(projectData.projects);
      setSessions(sessionData.sessions);
      setRepositories(repositoryData.repositories);
      setConnections(connectionData.providerConnections);
      setSandboxProvider(runtimeData.sandboxProvider);
      setError(null);
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Could not load AO Cloud.",
      );
    }
  }, [api]);

  useEffect(() => {
    if (!api) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [api, refresh]);

  const selectedProject = projects.find(({ id }) => id === selectedProjectId);
  const selectedSession = sessions.find(({ id }) => id === selectedSessionId);
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
  const visibleSessions = selectedProjectId
    ? sessions.filter(({ projectId }) => projectId === selectedProjectId)
    : sessions;

  const run = async (operation: () => Promise<unknown>) => {
    setLoading(true);
    try {
      await operation();
      await refresh();
      setError(null);
    } catch (operationError) {
      setError(
        operationError instanceof Error
          ? operationError.message
          : "Cloud operation failed.",
      );
    } finally {
      setLoading(false);
    }
  };

  const startOrchestrator = () => {
    if (!api || !selectedProjectId || !defaultAgent) return;
    void run(() =>
      api.createSession(
        {
          projectId: selectedProjectId,
          kind: "orchestrator",
          harness: defaultAgent,
          displayName: "Orchestrator",
          prompt: "Coordinate this project and wait for instructions.",
          providerConnectionId: daytonaConnections[0]?.id,
        },
        crypto.randomUUID(),
      ),
    );
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
    <main className="ao-cloud-app fixed inset-0 z-[60] h-dvh overflow-hidden bg-[#0a0b0d] font-[-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif] text-[#f4f5f7]">
      <div className="grid h-full grid-cols-[240px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col bg-[#17181c]">
          <div className="flex h-11 shrink-0 items-center gap-2 px-3">
            <img
              src="/ao-logo.svg"
              alt=""
              aria-hidden="true"
              className="size-[22px] rounded-md object-cover"
            />
            <span className="truncate text-sm font-semibold tracking-[-0.015em]">
              Agent Orchestrator
            </span>
            <span className="ml-auto rounded-full border border-white/10 px-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-white/40">
              Cloud
            </span>
          </div>
          <button
            className={`mx-1.5 flex h-8 items-center gap-2 rounded-lg px-2 text-left text-sm ${
              !selectedProjectId && view === "board"
                ? "bg-white/[0.07] text-white"
                : "text-[#9ba1aa] hover:bg-white/[0.04] hover:text-white"
            }`}
            onClick={() => {
              setSelectedProjectId(null);
              setSelectedSessionId(null);
              setView("board");
            }}
          >
            <LayoutDashboard className="size-[15px]" />
            Board
          </button>
          <div className="mt-4 flex items-center justify-between px-3">
            <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.05em] text-[#646a73]">
              Projects
            </span>
            <button
              className="grid size-5 place-items-center rounded-md text-[#646a73] transition-colors hover:bg-white/[0.04] hover:text-white"
              onClick={() => setShowProjectForm(true)}
              aria-label="Add cloud project"
            >
              <Plus className="size-[15px]" />
            </button>
          </div>
          <div className="mt-1 min-h-0 flex-1 overflow-auto px-1.5">
            {projects.map((project) => {
              const projectSessions = sessions.filter(
                ({ projectId }) => projectId === project.id,
              );
              return (
                <div key={project.id} className="mb-1">
                  <button
                    className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm ${
                      selectedProjectId === project.id && view === "board"
                        ? "bg-white/[0.07] text-white"
                        : "text-[#9ba1aa] hover:bg-white/[0.04] hover:text-white"
                    }`}
                    onClick={() => {
                      setSelectedProjectId(project.id);
                      setSelectedSessionId(null);
                      setView("board");
                    }}
                  >
                    <FolderGit2 className="size-[15px] shrink-0" />
                    <span className="truncate">{project.displayName}</span>
                  </button>
                  <div className="ml-[15px] border-l border-white/[0.06] pl-1.5">
                    {projectSessions.map((cloudSession) => (
                      <button
                        key={cloudSession.id}
                        className={`flex h-7 w-full items-center gap-2 rounded-lg border-l-2 px-2 text-left text-[12px] ${
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
                      >
                        {cloudSession.kind === "orchestrator" ? (
                          <OrchestratorIcon className="size-[14px] shrink-0" />
                        ) : (
                          <AgentAvatar
                            agent={cloudSession.harness}
                            className="size-[14px]"
                          />
                        )}
                        <span className="truncate">
                          {cloudSession.displayName}
                        </span>
                        <span
                          className={`ml-auto size-1.5 shrink-0 rounded-full ${statusColor(cloudSession)}`}
                          aria-hidden="true"
                        />
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="border-t border-white/[0.06] p-1.5">
            <button
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-sm text-[#9ba1aa] hover:bg-white/[0.04] hover:text-white"
              onClick={() => setView("settings")}
            >
              <Settings className="size-[15px]" />
              Settings
            </button>
            <button
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[12px] text-[#646a73] hover:bg-white/[0.04] hover:text-white"
              onClick={() => void logout()}
            >
              <LogOut className="size-[15px]" />
              <span className="truncate">
                {session?.user.email ?? "Logout"}
              </span>
            </button>
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col border-l border-white/[0.06] bg-[#0a0b0d]">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-4">
            <div className="min-w-0">
              <h1 className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium">
                {view === "settings"
                  ? "Cloud settings"
                  : selectedSession
                    ? `${selectedProject?.displayName ?? "Project"} / ${selectedSession.displayName}`
                    : (selectedProject?.displayName ?? "Board")}
              </h1>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {view === "session" && selectedSession ? (
                <>
                  <span className="mr-1 inline-flex h-7 items-center gap-1.5 rounded-md border border-white/10 px-2 font-mono text-[10px] uppercase tracking-[0.05em] text-[#9ba1aa]">
                    <span
                      className={`size-1.5 rounded-full ${statusColor(selectedSession)}`}
                    />
                    {selectedSession.status.replaceAll("_", " ")}
                  </span>
                  <button
                    className={button}
                    disabled={loading}
                    onClick={() =>
                      void run(() =>
                        api.setDesiredState(selectedSession.id, "running"),
                      )
                    }
                  >
                    <Play className="size-3.5" />
                    Run
                  </button>
                  <button
                    className={button}
                    disabled={loading}
                    onClick={() =>
                      void run(() =>
                        api.setDesiredState(selectedSession.id, "paused"),
                      )
                    }
                  >
                    <Pause className="size-3.5" />
                    Pause
                  </button>
                  <button
                    className={button}
                    disabled={loading}
                    onClick={() =>
                      void run(() =>
                        api.setDesiredState(selectedSession.id, "deleted"),
                      )
                    }
                    aria-label={`Delete ${selectedSession.displayName}`}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </>
              ) : view === "board" && selectedProjectId ? (
                <>
                  <button
                    className={primaryButton}
                    onClick={() => setShowSessionForm(true)}
                    disabled={loading}
                  >
                    <Plus className="size-3.5" />
                    New task
                  </button>
                  <button
                    className={button}
                    disabled={
                      loading || (!selectedProjectOrchestrator && !defaultAgent)
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
          </header>

          {error && (
            <div
              role="alert"
              className="border-b border-[#ef6b6b]/30 bg-[#ef6b6b]/10 px-4 py-2 text-xs text-[#ef9b9b]"
            >
              {error}
            </div>
          )}

          <div className="min-h-0 flex-1">
            {view === "settings" ? (
              <CloudSettings
                api={api}
                connections={connections}
                sandboxProvider={sandboxProvider}
                run={run}
              />
            ) : view === "session" && selectedSession ? (
              <CloudTerminal api={api} sessionId={selectedSession.id} />
            ) : (
              <SessionBoard
                sessions={visibleSessions}
                projects={projects}
                onSelect={(cloudSession) => {
                  setSelectedSessionId(cloudSession.id);
                  setView("session");
                }}
                onCreateOrchestrator={
                  selectedProjectId && defaultAgent
                    ? startOrchestrator
                    : undefined
                }
                agentAvailable={Boolean(defaultAgent)}
                onOpenSettings={() => setView("settings")}
              />
            )}
          </div>
        </section>
      </div>

      {showProjectForm && (
        <ProjectForm
          repositories={repositories}
          onClose={() => setShowProjectForm(false)}
          onSubmit={(input) =>
            run(() => api.createProject(input)).then(() =>
              setShowProjectForm(false),
            )
          }
        />
      )}
      {showSessionForm && selectedProjectId && (
        <SessionForm
          projectId={selectedProjectId}
          providerConnectionId={daytonaConnections[0]?.id}
          connections={connections}
          onOpenSettings={() => {
            setShowSessionForm(false);
            setView("settings");
          }}
          onClose={() => setShowSessionForm(false)}
          onSubmit={(input) =>
            run(() => api.createSession(input, crypto.randomUUID())).then(() =>
              setShowSessionForm(false),
            )
          }
        />
      )}
    </main>
  );
}

function SessionBoard({
  sessions,
  projects,
  onSelect,
  onCreateOrchestrator,
  agentAvailable,
  onOpenSettings,
}: {
  sessions: CloudSession[];
  projects: CloudProject[];
  onSelect: (session: CloudSession) => void;
  onCreateOrchestrator?: () => void;
  agentAvailable: boolean;
  onOpenSettings: () => void;
}) {
  const columns = [
    [
      "Working",
      "#36c2b4",
      sessions.filter((item) =>
        ["working", "idle", "exited"].includes(item.status),
      ),
    ],
    [
      "Needs you",
      "#f2b84b",
      sessions.filter((item) =>
        ["needs_input", "ci_failed", "changes_requested"].includes(item.status),
      ),
    ],
    [
      "In review",
      "#5b8def",
      sessions.filter((item) =>
        ["pr_open", "review_pending"].includes(item.status),
      ),
    ],
    [
      "Ready to merge",
      "#9ad97a",
      sessions.filter((item) =>
        ["approved", "mergeable", "merged"].includes(item.status),
      ),
    ],
  ] as const;
  if (sessions.length === 0) {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div className="max-w-sm">
          <OrchestratorIcon className="mx-auto size-5 text-[#4d8dff]" />
          <h2 className="mt-4 text-base">No cloud sessions</h2>
          <p className="mt-2 text-sm leading-6 text-white/45">
            Start the project orchestrator. AO will provision its Daytona
            environment and it can create isolated workers with normal AO
            commands.
          </p>
          {onCreateOrchestrator ? (
            <button
              className={`${primaryButton} mt-5`}
              onClick={onCreateOrchestrator}
            >
              <Play className="size-3.5" />
              Start orchestrator
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
                  <span
                    className={`ml-auto size-[7px] shrink-0 rounded-full ${statusColor(cloudSession)}`}
                  />
                </div>
                <div className="mt-3 flex items-center gap-2 font-mono text-[10px] text-[#646a73]">
                  <span className="min-w-0 flex-1 truncate">
                    {
                      projects.find(({ id }) => id === cloudSession.projectId)
                        ?.displayName
                    }
                  </span>
                  <span className="shrink-0 uppercase tracking-[0.04em]">
                    {cloudSession.status.replaceAll("_", " ")}
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
  connections,
  sandboxProvider,
  run,
}: {
  api: CloudAPI;
  connections: ProviderConnection[];
  sandboxProvider: "daytona" | "fly";
  run: (operation: () => Promise<unknown>) => Promise<void>;
}) {
  const [apiKey, setAPIKey] = useState("");
  const [target, setTarget] = useState<"us" | "eu">("us");
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
          <div className="mt-5 divide-y divide-white/10 border-y border-white/10">
            {CLOUD_AGENTS.map((agent) => (
              <AgentConnectionRow
                key={agent.id}
                agent={agent}
                connection={connectedAgents.get(agent.id)}
                run={run}
                connect={(credentialType, secret) =>
                  api.connectAgent(agent.id, { credentialType, secret })
                }
                disconnect={() => api.disconnectAgent(agent.id)}
              />
            ))}
          </div>
        </section>

        {sandboxProvider === "fly" ? (
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
                  api.connectDaytona({
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
  connect,
  disconnect,
}: {
  agent: (typeof CLOUD_AGENTS)[number];
  connection?: ProviderConnection;
  run: (operation: () => Promise<unknown>) => Promise<void>;
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
              onClick={() => setReplacing((value) => !value)}
            >
              {replacing ? "Cancel" : "Re-authenticate"}
            </button>
            <button
              type="button"
              className={button}
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
          <button className={primaryButton} type="submit">
            Connect
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
  onClose,
  onSubmit,
}: {
  repositories: CloudRepository[];
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
          >
            {repositories.map((repository) => (
              <option value={repository.url} key={repository.url}>
                {repository.fullName}
                {repository.private ? " · private" : ""}
              </option>
            ))}
          </select>
        </label>
        {repositories.length === 0 && (
          <p className="text-sm text-[#e8c14a]">
            No repositories were returned by the configured GitHub connection.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={button} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={primaryButton} disabled={!selected}>
            Add project
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
  onOpenSettings,
  onClose,
  onSubmit,
}: {
  projectId: string;
  providerConnectionId?: string;
  connections: ProviderConnection[];
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
          <button type="submit" className={primaryButton} disabled={!harness}>
            Spawn worker
          </button>
        </div>
      </form>
    </Overlay>
  );
}
