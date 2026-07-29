"use client";

import {
  Cloud,
  FolderGit2,
  LoaderCircle,
  LogOut,
  Pause,
  Play,
  Plus,
  Settings,
  Square,
  TerminalSquare,
  Trash2,
  Waypoints,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CloudAPI,
  type CloudProject,
  type CloudRepository,
  type CloudSession,
  type ProviderConnection,
} from "@/lib/cloud-api";
import { useAuth } from "../auth/AuthProvider";
import { CloudTerminal } from "./CloudTerminal";

type View = "board" | "session" | "settings";

const button =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border px-2.5 text-sm text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45";
const primaryButton =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-[#4d8dff] px-3 text-sm text-white transition-colors hover:bg-[#397df0] disabled:cursor-not-allowed disabled:opacity-45";
const field =
  "h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-[#4d8dff]";

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
  return "bg-[#74b98a]";
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
      const [projectData, sessionData, repositoryData, connectionData] =
        await Promise.all([
          api.projects(),
          api.sessions(),
          api.repositories(),
          api.providerConnections(),
        ]);
      setProjects(projectData.projects);
      setSessions(sessionData.sessions);
      setRepositories(repositoryData.repositories);
      setConnections(connectionData.providerConnections);
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
    <main className="fixed inset-0 z-40 h-dvh overflow-hidden bg-[#0a0b0d] text-[#f4f5f7]">
      <div className="grid h-full grid-cols-[240px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-white/10 bg-[#08090b]">
          <div className="flex h-14 items-center gap-2 border-b border-white/10 px-3">
            <Waypoints className="size-4 text-[#4d8dff]" />
            <span className="text-sm">Agent Orchestrator</span>
            <span className="ml-auto rounded-full border border-white/10 px-1.5 font-mono text-[9px] uppercase text-white/40">
              Cloud
            </span>
          </div>
          <button
            className={`mx-2 mt-2 flex h-8 items-center gap-2 px-2 text-left text-sm ${
              !selectedProjectId && view === "board"
                ? "bg-white/10 text-white"
                : "text-white/65 hover:bg-white/5"
            }`}
            onClick={() => {
              setSelectedProjectId(null);
              setView("board");
            }}
          >
            <Cloud className="size-3.5" />
            All cloud sessions
          </button>
          <div className="mt-5 flex items-center justify-between px-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
              Projects
            </span>
            <button
              className="text-white/45 hover:text-white"
              onClick={() => setShowProjectForm(true)}
              aria-label="Add cloud project"
            >
              <Plus className="size-3.5" />
            </button>
          </div>
          <div className="mt-1 min-h-0 flex-1 overflow-auto px-2">
            {projects.map((project) => (
              <button
                key={project.id}
                className={`flex h-8 w-full items-center gap-2 px-2 text-left text-sm ${
                  selectedProjectId === project.id
                    ? "border-l-2 border-[#4d8dff] bg-white/10 text-white"
                    : "border-l-2 border-transparent text-white/65 hover:bg-white/5"
                }`}
                onClick={() => {
                  setSelectedProjectId(project.id);
                  setView("board");
                }}
              >
                <FolderGit2 className="size-3.5 shrink-0" />
                <span className="truncate">{project.displayName}</span>
              </button>
            ))}
          </div>
          <div className="border-t border-white/10 p-2">
            <button
              className="flex h-8 w-full items-center gap-2 px-2 text-sm text-white/60 hover:bg-white/5"
              onClick={() => setView("settings")}
            >
              <Settings className="size-3.5" />
              Cloud settings
            </button>
            <button
              className="flex h-8 w-full items-center gap-2 px-2 text-sm text-white/60 hover:bg-white/5"
              onClick={() => void logout()}
            >
              <LogOut className="size-3.5" />
              {session?.user.email ?? "Logout"}
            </button>
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col">
          <header className="flex h-14 shrink-0 items-center border-b border-white/10 px-4">
            <div className="min-w-0">
              <h1 className="truncate text-sm">
                {view === "settings"
                  ? "Cloud settings"
                  : (selectedSession?.displayName ??
                    selectedProject?.displayName ??
                    "Cloud sessions")}
              </h1>
              <p className="truncate font-mono text-[10px] text-white/35">
                {selectedSession?.branch ??
                  selectedProject?.repositoryUrl ??
                  `${sessions.filter((item) => item.activityState === "active").length} working`}
              </p>
            </div>
            {view !== "settings" && (
              <button
                className={`${primaryButton} ml-auto`}
                onClick={() => setShowSessionForm(true)}
                disabled={!selectedProjectId || loading}
              >
                <Plus className="size-3.5" />
                New worker
              </button>
            )}
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
              <CloudSettings api={api} connections={connections} run={run} />
            ) : view === "session" && selectedSession ? (
              <div className="grid h-full min-h-0 grid-rows-[1fr_auto]">
                <CloudTerminal api={api} sessionId={selectedSession.id} />
                <SessionActions
                  session={selectedSession}
                  loading={loading}
                  setState={(state) =>
                    void run(() =>
                      api.setDesiredState(selectedSession.id, state),
                    )
                  }
                />
              </div>
            ) : (
              <SessionBoard
                sessions={visibleSessions}
                projects={projects}
                onSelect={(cloudSession) => {
                  setSelectedSessionId(cloudSession.id);
                  setView("session");
                }}
                onCreateOrchestrator={
                  selectedProjectId
                    ? () =>
                        void run(() =>
                          api.createSession(
                            {
                              projectId: selectedProjectId,
                              kind: "orchestrator",
                              harness: "claude-code",
                              displayName: "Orchestrator",
                              prompt:
                                "Coordinate this project and wait for instructions.",
                              providerConnectionId: connections[0]?.id,
                            },
                            crypto.randomUUID(),
                          ),
                        )
                    : undefined
                }
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
          providerConnectionId={connections[0]?.id}
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
}: {
  sessions: CloudSession[];
  projects: CloudProject[];
  onSelect: (session: CloudSession) => void;
  onCreateOrchestrator?: () => void;
}) {
  const columns = [
    [
      "Working",
      sessions.filter((item) =>
        ["working", "idle", "exited"].includes(item.status),
      ),
    ],
    [
      "Needs you",
      sessions.filter((item) =>
        ["needs_input", "ci_failed", "changes_requested"].includes(item.status),
      ),
    ],
    [
      "In review",
      sessions.filter((item) =>
        ["pr_open", "review_pending"].includes(item.status),
      ),
    ],
    [
      "Ready to merge",
      sessions.filter((item) =>
        ["approved", "mergeable", "merged"].includes(item.status),
      ),
    ],
  ] as const;
  if (sessions.length === 0) {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div className="max-w-sm">
          <Waypoints className="mx-auto size-5 text-[#4d8dff]" />
          <h2 className="mt-4 text-base">No cloud sessions</h2>
          <p className="mt-2 text-sm leading-6 text-white/45">
            Start the project orchestrator. AO will provision its Daytona
            environment and it can create isolated workers with normal AO
            commands.
          </p>
          {onCreateOrchestrator && (
            <button
              className={`${primaryButton} mt-5`}
              onClick={onCreateOrchestrator}
            >
              <Play className="size-3.5" />
              Start orchestrator
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="grid h-full min-h-0 grid-cols-4 divide-x divide-white/10 overflow-x-auto">
      {columns.map(([title, items]) => (
        <div key={title} className="min-w-[230px] overflow-auto p-3">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-white/45">
              {title}
            </h2>
            <span className="text-xs text-white/30">{items.length}</span>
          </div>
          <div className="space-y-2">
            {items.map((cloudSession) => (
              <button
                key={cloudSession.id}
                className="w-full border border-white/10 bg-[#15171b] p-3 text-left transition-colors hover:border-white/20 hover:bg-[#191b20]"
                onClick={() => onSelect(cloudSession)}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`size-2 rounded-full ${statusColor(cloudSession)}`}
                  />
                  <span className="truncate text-sm">
                    {cloudSession.displayName}
                  </span>
                </div>
                <p className="mt-2 truncate font-mono text-[10px] text-white/35">
                  {
                    projects.find(({ id }) => id === cloudSession.projectId)
                      ?.displayName
                  }
                </p>
                <p className="mt-1 truncate font-mono text-[10px] text-white/25">
                  {cloudSession.branch}
                </p>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SessionActions({
  session,
  loading,
  setState,
}: {
  session: CloudSession;
  loading: boolean;
  setState: (state: "running" | "paused" | "deleted") => void;
}) {
  return (
    <div className="flex items-center gap-2 border-t border-white/10 bg-[#15171b] px-3 py-2">
      <TerminalSquare className="size-3.5 text-white/35" />
      <span className="mr-auto font-mono text-[10px] text-white/40">
        {session.harness} · {session.status}
      </span>
      <button
        className={button}
        disabled={loading}
        onClick={() => setState("running")}
      >
        <Play className="size-3.5" />
        Run
      </button>
      <button
        className={button}
        disabled={loading}
        onClick={() => setState("paused")}
      >
        <Pause className="size-3.5" />
        Pause
      </button>
      <button
        className={button}
        disabled={loading}
        onClick={() => setState("deleted")}
      >
        <Trash2 className="size-3.5" />
        Delete
      </button>
    </div>
  );
}

function CloudSettings({
  api,
  connections,
  run,
}: {
  api: CloudAPI;
  connections: ProviderConnection[];
  run: (operation: () => Promise<unknown>) => Promise<void>;
}) {
  const [apiKey, setAPIKey] = useState("");
  const [target, setTarget] = useState<"us" | "eu">("us");
  return (
    <div className="h-full overflow-auto p-6">
      <div className="max-w-xl">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
          Sandbox provider
        </p>
        <h2 className="mt-2 text-base">Daytona</h2>
        <p className="mt-2 text-sm leading-6 text-white/45">
          Credentials are validated by AO Cloud, encrypted outside session
          environments, and never returned to this browser.
        </p>
        {connections.map((connection) => (
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
            onChange={(event) => setTarget(event.target.value as "us" | "eu")}
          >
            <option value="us">United States</option>
            <option value="eu">Europe</option>
          </select>
          <button className={primaryButton} type="submit">
            Save and validate
          </button>
        </form>
      </div>
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
  onClose,
  onSubmit,
}: {
  projectId: string;
  providerConnectionId?: string;
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
  const [harness, setHarness] = useState("claude-code");
  return (
    <Overlay title="New cloud worker" onClose={onClose}>
      <form
        className="space-y-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
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
        <select
          className={field}
          value={harness}
          onChange={(event) => setHarness(event.target.value)}
        >
          <option value="claude-code">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="cursor">Cursor</option>
        </select>
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
          <button type="submit" className={primaryButton}>
            Spawn worker
          </button>
        </div>
      </form>
    </Overlay>
  );
}
