"use client";

import Link from "next/link";
import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import type { ProjectInfo } from "@/lib/project-name";
import { getAttentionLevel, type DashboardSession, type AttentionLevel } from "@/lib/types";
import { isOrchestratorSession } from "@aoagents/ao-core/types";
import { getSessionTitle, humanizeBranch } from "@/lib/format";
import { usePopoverClamp } from "@/hooks/usePopoverClamp";
import { projectDashboardPath, projectSessionPath } from "@/lib/routes";
import { ThemeToggle } from "./ThemeToggle";
import { AddProjectModal } from "./AddProjectModal";
import { ProjectSettingsModal } from "./ProjectSettingsModal";

/** Minimal shape needed to render an orchestrator link in the sidebar. */
export interface ProjectSidebarOrchestrator {
  id: string;
  projectId: string;
}

interface ProjectSidebarProps {
  projects: ProjectInfo[];
  sessions: DashboardSession[] | null;
  /**
   * Per-project orchestrator link. Sourced upstream from `/api/sessions`
   * (the `orchestrators` field), which already applies the canonical
   * "prefer live, fall back to terminal" selection. Not derivable from
   * `sessions`: the sessions endpoint strips orchestrators out.
   */
  orchestrators?: ProjectSidebarOrchestrator[];
  activeProjectId: string | undefined;
  activeSessionId: string | undefined;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onMobileClose?: () => void;
}

type SessionDotLevel = "respond" | "review" | "action" | "pending" | "working" | "merge" | "done";

function SessionDot({ level }: { level: SessionDotLevel }) {
  return (
    <div
      className={cn(
        "sidebar-session-dot shrink-0 rounded-full",
        level === "working" && "sidebar-session-dot--glow",
      )}
      data-level={level}
    />
  );
}

// ProjectSidebar consumes `getAttentionLevel()` without passing a mode,
// so the function defaults to "detailed" and `action` never appears here
// in practice. The entry is kept for exhaustiveness — TypeScript requires
// every `AttentionLevel` variant to be present in this `Record` — and
// as forward-compat in case the sidebar ever opts into simple mode.
const SHOW_SESSION_ID_KEY = "ao:sidebar:show-session-id";

function loadShowSessionId(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SHOW_SESSION_ID_KEY) === "true";
  } catch {
    return false;
  }
}

const LEVEL_LABELS: Record<AttentionLevel, string> = {
  working: "working",
  pending: "pending",
  review: "review",
  respond: "respond",
  action: "action",
  merge: "merge",
  done: "done",
};

export function ProjectSidebar(props: ProjectSidebarProps) {
  if (props.projects.length === 0) {
    return <ProjectSidebarEmpty collapsed={props.collapsed} />;
  }
  return <ProjectSidebarInner {...props} />;
}

function ProjectSidebarEmpty({ collapsed = false }: { collapsed?: boolean }) {
  const [addProjectOpen, setAddProjectOpen] = useState(false);

  if (collapsed) {
    return (
      <aside className="project-sidebar project-sidebar--collapsed flex h-full flex-col items-center gap-1 py-2">
        <button
          type="button"
          className="project-sidebar__add-btn"
          aria-label="New project"
          onClick={() => setAddProjectOpen(true)}
        >
          <svg
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <AddProjectModal open={addProjectOpen} onClose={() => setAddProjectOpen(false)} />
      </aside>
    );
  }

  return (
    <aside className="project-sidebar flex h-full flex-col">
      <div className="project-sidebar__compact-hdr">
        <span className="project-sidebar__sect-label">Projects</span>
        <button
          type="button"
          className="project-sidebar__add-btn"
          aria-label="New project"
          onClick={() => setAddProjectOpen(true)}
        >
          <svg
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      <div className="project-sidebar__empty flex-1 text-[var(--color-text-tertiary)]">
        No projects yet. Click + to add one.
      </div>
      <div className="project-sidebar__footer">
        <div className="flex items-center justify-end gap-1 border-t border-[var(--color-border-subtle)] px-2 py-2">
          <ThemeToggle className="project-sidebar__theme-toggle" />
        </div>
      </div>
      <AddProjectModal open={addProjectOpen} onClose={() => setAddProjectOpen(false)} />
    </aside>
  );
}

function ProjectSidebarInner({
  projects,
  sessions,
  orchestrators,
  activeProjectId,
  activeSessionId,
  loading = false,
  error = false,
  onRetry,
  collapsed = false,
  onToggleCollapsed: _onToggleCollapsed,
  onMobileClose,
}: ProjectSidebarProps) {
  const router = useRouter();
  const isLoading = loading || sessions === null;

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(activeProjectId && activeProjectId !== "all" ? [activeProjectId] : []),
  );
  const [showKilled, setShowKilled] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [showSessionId, setShowSessionId] = useState<boolean>(loadShowSessionId);
  // Inline session-rename state. Only one row is edited at a time. `pendingRenames`
  // mirrors the in-flight / just-saved value so the new label appears immediately
  // without waiting for the next SSE refresh.
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [pendingRenames, setPendingRenames] = useState<Map<string, string>>(new Map());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectMenuOpenId, setProjectMenuOpenId] = useState<string | null>(null);
  const [projectSettingsProjectId, setProjectSettingsProjectId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [removedProjectIds, setRemovedProjectIds] = useState<Set<string>>(new Set());
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsPopoverRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const projectMenuPopoverRef = useRef<HTMLDivElement>(null);
  usePopoverClamp(settingsOpen, settingsPopoverRef);
  usePopoverClamp(Boolean(projectMenuOpenId), projectMenuPopoverRef);

  // Persist the session-id preference across reloads.
  useEffect(() => {
    try {
      window.localStorage.setItem(SHOW_SESSION_ID_KEY, String(showSessionId));
    } catch {
      // localStorage unavailable — accept the in-memory state for this session.
    }
  }, [showSessionId]);

  // Close the settings popover on outside click or Escape.
  useEffect(() => {
    if (!settingsOpen) return;
    const handlePointer = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (!projectMenuOpenId) return;
    const handlePointer = (e: MouseEvent) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setProjectMenuOpenId(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProjectMenuOpenId(null);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [projectMenuOpenId]);

  useEffect(() => {
    if (activeProjectId && activeProjectId !== "all") {
      setExpandedProjects((prev) => new Set([...prev, activeProjectId]));
    }
  }, [activeProjectId]);

  useEffect(() => {
    setRemovedProjectIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(
        [...prev].filter((projectId) => !projects.some((project) => project.id === projectId)),
      );
      return next.size === prev.size ? prev : next;
    });
  }, [projects]);

  const visibleProjects = useMemo(
    () => projects.filter((project) => !removedProjectIds.has(project.id)),
    [projects, removedProjectIds],
  );

  const prefixByProject = useMemo(
    () => new Map(visibleProjects.map((p) => [p.id, p.sessionPrefix ?? p.id])),
    [visibleProjects],
  );

  const allPrefixes = useMemo(
    () => visibleProjects.map((p) => p.sessionPrefix ?? p.id),
    [visibleProjects],
  );

  // The API (selectPreferredOrchestratorId) sends at most one entry per
  // project, so collapsing into a Map keyed by projectId is lossless. If a
  // future API change starts emitting multiples, the last one wins here.
  const orchestratorByProject = useMemo(
    () => new Map((orchestrators ?? []).map((o) => [o.projectId, o])),
    [orchestrators],
  );

  const sessionsByProject = useMemo(() => {
    const map = new Map<string, DashboardSession[]>();
    // Build a set of valid project IDs to filter sessions strictly
    const validProjectIds = new Set(visibleProjects.map((p) => p.id));

    for (const s of sessions ?? []) {
      // Only include sessions whose projectId matches a configured project
      if (!validProjectIds.has(s.projectId)) continue;
      if (isOrchestratorSession(s, prefixByProject.get(s.projectId), allPrefixes)) continue;
      // Keep terminal sessions visible when they still need human attention.
      // Otherwise ACTION-column cards disappear from the sidebar just because
      // their runtime has ended.
      const level = getAttentionLevel(s);
      if (level === "done") {
        if (s.status === "killed" ? !showKilled && !showDone : !showDone) continue;
      }
      const list = map.get(s.projectId) ?? [];
      list.push(s);
      map.set(s.projectId, list);
    }
    return map;
  }, [sessions, prefixByProject, allPrefixes, visibleProjects, showKilled, showDone]);

  // Clear an optimistic rename once the prop session.displayName catches up.
  // Without this, we'd keep masking the server value forever after a save.
  useEffect(() => {
    if (pendingRenames.size === 0 || !sessions) return;
    const next = new Map(pendingRenames);
    let changed = false;
    for (const session of sessions) {
      const pending = next.get(session.id);
      if (pending !== undefined && (session.displayName ?? "") === pending) {
        next.delete(session.id);
        changed = true;
      }
    }
    if (changed) setPendingRenames(next);
  }, [sessions, pendingRenames]);

  const startRename = (session: DashboardSession, currentTitle: string) => {
    // Prefer the in-flight optimistic value over the prop — if the user opens
    // rename while a previous PATCH is still propagating, the prop still shows
    // the pre-rename value but we want the input to start from the latest.
    // Auto-derived displayName isn't pre-filled (user-set flag absent) — start
    // from the live title so the user types over the visible label.
    const pending = pendingRenames.get(session.id);
    const initial =
      pending ?? (session.displayNameUserSet ? (session.displayName ?? "") : "");
    setEditingSessionId(session.id);
    setEditingValue(initial || currentTitle);
  };

  const cancelRename = () => {
    setEditingSessionId(null);
    setEditingValue("");
  };

  const submitRename = async (sessionId: string) => {
    // Guard against double-submit. submitRename is wired to both Enter (which
    // unmounts the input) and onBlur (which can fire during that unmount in
    // some browsers); without this, both paths would fire a PATCH.
    if (editingSessionId !== sessionId) return;
    // Trim, but allow empty — empty means "revert to default" on the server.
    const next = editingValue.trim();
    setEditingSessionId(null);
    setEditingValue("");
    setPendingRenames((prev) => {
      const map = new Map(prev);
      map.set(sessionId, next);
      return map;
    });
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: next === "" ? null : next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Failed to rename session");
      }
    } catch {
      // Roll back the optimistic update so the row reverts to the prop value.
      // The user sees the original name return — no further notification is
      // needed for this niche failure path.
      setPendingRenames((prev) => {
        const map = new Map(prev);
        map.delete(sessionId);
        return map;
      });
    }
  };

  const navigate = (url: string, session?: DashboardSession) => {
    if (session) {
      try {
        sessionStorage.setItem(`ao-session-nav:${session.id}`, JSON.stringify(session));
      } catch {
        // sessionStorage unavailable — silent fallback
      }
    }
    router.push(url);
    onMobileClose?.();
  };

  const toggleExpand = (projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  const handleRemoveProject = async (project: ProjectInfo) => {
    const confirmed = window.confirm(
      `Remove project ${project.name} from AO? This clears its AO sessions/history and removes it from the portfolio, but keeps the repository folder on disk.`,
    );
    if (!confirmed) return;

    setDeletingProjectId(project.id);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "DELETE",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          (body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error
            : null) ?? "Failed to remove project.",
        );
      }

      setRemovedProjectIds((prev) => new Set(prev).add(project.id));
      setExpandedProjects((prev) => {
        const next = new Set(prev);
        next.delete(project.id);
        return next;
      });
      setProjectMenuOpenId(null);
      if (activeProjectId === project.id) {
        router.push("/");
      } else if ("refresh" in router && typeof router.refresh === "function") {
        router.refresh();
      }
      onMobileClose?.();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to remove project.");
    } finally {
      setDeletingProjectId(null);
    }
  };

  if (collapsed) {
    return (
      <aside
        className={cn(
          "project-sidebar project-sidebar--collapsed flex flex-col h-full items-center py-2 gap-1 overflow-y-auto",
        )}
      >
        {visibleProjects.map((project, idx) => {
          const workerSessions = sessionsByProject.get(project.id) ?? [];
          // sessionsByProject already applies the showDone filter consistently.
          const visibleSessions = workerSessions;
          const projectAbbr = project.name.slice(0, 2).toUpperCase();
          return (
            <div key={project.id} className="flex flex-col items-center gap-0.5 w-full px-1">
              {idx > 0 && <div className="project-sidebar__collapsed-divider" aria-hidden="true" />}
              <a
                href={projectDashboardPath(project.id)}
                className={cn(
                  "project-sidebar__collapsed-icon",
                  activeProjectId === project.id && "project-sidebar__collapsed-icon--active",
                )}
                title={project.name}
                aria-label={project.name}
              >
                <span className="project-sidebar__collapsed-abbr">{projectAbbr}</span>
              </a>
              {visibleSessions.slice(0, 5).map((session) => {
                const level = getAttentionLevel(session);
                const rawTitle = session.branch ?? getSessionTitle(session);
                const displayTitle = session.branch
                  ? humanizeBranch(session.branch) || rawTitle
                  : rawTitle;
                const abbr = displayTitle.replace(/\s+/g, "").slice(0, 3).toUpperCase();
                const isActive = activeSessionId === session.id;
                const sessionHref = projectSessionPath(project.id, session.id);
                return (
                  <a
                    key={session.id}
                    href={sessionHref}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
                      e.preventDefault();
                      navigate(sessionHref, session);
                    }}
                    className={cn(
                      "project-sidebar__collapsed-session-btn",
                      isActive && "project-sidebar__collapsed-session-btn--active",
                    )}
                    data-level={level}
                    title={rawTitle}
                    aria-label={rawTitle}
                  >
                    <span className="project-sidebar__session-abbr-first">{abbr[0]}</span>
                    <span className="project-sidebar__session-abbr-rest">{abbr.slice(1)}</span>
                  </a>
                );
              })}
              {visibleSessions.length > 5 && (
                <span className="project-sidebar__collapsed-overflow">
                  +{visibleSessions.length - 5}
                </span>
              )}
            </div>
          );
        })}
      </aside>
    );
  }

  return (
    <aside className="project-sidebar flex h-full flex-col">
      <div className="project-sidebar__compact-hdr">
        <span className="project-sidebar__sect-label">Projects</span>
        <button
          type="button"
          className="project-sidebar__add-btn"
          aria-label="New project"
          onClick={() => setAddProjectOpen(true)}
        >
          <svg
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      {/* Stale-data banner: keep cached sessions visible on fetch failure but
            surface the error so users know the list may be out of date. */}
      {error && sessions && sessions.length > 0 ? (
        <div
          role="status"
          className="mx-3 mb-2 flex items-center justify-between gap-2 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-[11px] text-[var(--color-text-tertiary)]"
        >
          <span>Failed to refresh · showing cached sessions</span>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="font-medium text-[var(--color-link)] hover:underline"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Project tree */}
      <div className="project-sidebar__tree flex-1 overflow-y-auto overflow-x-hidden">
        {visibleProjects.map((project) => {
          const workerSessions = sessionsByProject.get(project.id) ?? [];
          const isExpanded = expandedProjects.has(project.id);
          const isActive = activeProjectId === project.id;
          const isDegraded = Boolean(project.resolveError);
          const projectHref = projectDashboardPath(project.id);
          // sessionsByProject already applies the showDone filter consistently.
          const visibleSessions = workerSessions;
          const hasActiveSessions = visibleSessions.length > 0;

          const orchestratorLink = orchestratorByProject.get(project.id) ?? null;

          return (
            <div key={project.id} className="project-sidebar__project">
              {/* Project row: toggle + action buttons */}
              <div className="project-sidebar__proj-row flex items-center">
                {isDegraded ? (
                  <a
                    href={projectHref}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
                      e.preventDefault();
                      navigate(projectHref);
                    }}
                    className={cn(
                      "project-sidebar__proj-toggle project-sidebar__proj-toggle--link project-sidebar__proj-toggle--degraded",
                      isActive && "project-sidebar__proj-toggle--active",
                    )}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <svg
                      className="project-sidebar__proj-chevron project-sidebar__proj-chevron--degraded"
                      width="10"
                      height="10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path d="M12 9v4" />
                      <path d="M12 17h.01" />
                      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.72 3h16.92a2 2 0 0 0 1.72-3L13.7 3.86a2 2 0 0 0-3.4 0Z" />
                    </svg>
                    <span className="project-sidebar__proj-name">{project.name}</span>
                    <span className="project-sidebar__proj-badge project-sidebar__proj-badge--degraded">
                      degraded
                    </span>
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={() => toggleExpand(project.id)}
                    className={cn(
                      "project-sidebar__proj-toggle",
                      isActive && "project-sidebar__proj-toggle--active",
                    )}
                    aria-expanded={isExpanded}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <svg
                      className={cn(
                        "project-sidebar__proj-chevron",
                        isExpanded && "project-sidebar__proj-chevron--open",
                      )}
                      width="10"
                      height="10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      viewBox="0 0 24 24"
                    >
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                    <span className="project-sidebar__proj-name">{project.name}</span>
                    <span
                      className={cn(
                        "project-sidebar__proj-badge",
                        hasActiveSessions && "project-sidebar__proj-badge--active",
                      )}
                    >
                      {workerSessions.length}
                    </span>
                  </button>
                )}

                {/* Dashboard button */}
                {!isDegraded ? (
                  <Link
                    href={projectHref}
                    onClick={(e) => {
                      e.stopPropagation();
                      onMobileClose?.();
                    }}
                    className="project-sidebar__proj-action"
                    aria-label={`Open ${project.name} dashboard`}
                    title="Dashboard"
                  >
                    <svg
                      width="12"
                      height="12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                    >
                      <path d="M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-10h8V3h-8z" />
                    </svg>
                  </Link>
                ) : null}

                {/* Orchestrator button */}
                {!isDegraded && orchestratorLink && (
                  <Link
                    href={projectSessionPath(project.id, orchestratorLink.id)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onMobileClose?.();
                    }}
                    className="project-sidebar__proj-action"
                    aria-label={`Open ${project.name} orchestrator`}
                    title="Orchestrator"
                  >
                    <svg
                      width="12"
                      height="12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                    >
                      <circle cx="12" cy="5" r="2" fill="currentColor" stroke="none" />
                      <path d="M12 7v4M12 11H6M12 11h6M6 11v3M12 11v3M18 11v3" />
                      <circle cx="6" cy="17" r="2" />
                      <circle cx="12" cy="17" r="2" />
                      <circle cx="18" cy="17" r="2" />
                    </svg>
                  </Link>
                )}

                <div
                  className="project-sidebar__proj-menu"
                  ref={projectMenuOpenId === project.id ? projectMenuRef : undefined}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setProjectMenuOpenId((current) =>
                        current === project.id ? null : project.id,
                      );
                    }}
                    className="project-sidebar__proj-action project-sidebar__proj-action--menu"
                    aria-label={`Project actions for ${project.name}`}
                    aria-expanded={projectMenuOpenId === project.id}
                    aria-haspopup="menu"
                    title="Project actions"
                  >
                    <svg
                      width="12"
                      height="12"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="5" r="1.75" />
                      <circle cx="12" cy="12" r="1.75" />
                      <circle cx="12" cy="19" r="1.75" />
                    </svg>
                  </button>
                  {projectMenuOpenId === project.id ? (
                    <div
                      ref={projectMenuPopoverRef}
                      className="project-sidebar__proj-menu-popover"
                      role="menu"
                      aria-label={`${project.name} actions`}
                    >
                      {orchestratorLink ? (
                        <button
                          type="button"
                          className="project-sidebar__proj-menu-item"
                          role="menuitem"
                          onClick={() => {
                            setProjectMenuOpenId(null);
                            navigate(projectSessionPath(project.id, orchestratorLink.id));
                          }}
                        >
                          Open orchestrator
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="project-sidebar__proj-menu-item"
                        role="menuitem"
                        onClick={() => {
                          setProjectMenuOpenId(null);
                          setProjectSettingsProjectId(project.id);
                        }}
                      >
                        Project settings
                      </button>
                      <button
                        type="button"
                        className="project-sidebar__proj-menu-item project-sidebar__proj-menu-item--danger"
                        role="menuitem"
                        onClick={() => void handleRemoveProject(project)}
                        disabled={deletingProjectId === project.id}
                      >
                        {deletingProjectId === project.id ? "Removing..." : "Remove project"}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>

              {isDegraded ? (
                <div className="project-sidebar__degraded-note">Config needs repair</div>
              ) : null}

              {/* Sessions */}
              {!isDegraded && isExpanded && (
                <div className="project-sidebar__sessions">
                  {isLoading ? (
                    <div className="space-y-2 px-3 py-2" aria-label="Loading sessions">
                      {Array.from({ length: 3 }, (_, index) => (
                        <div
                          key={`${project.id}-loading-${index}`}
                          className="flex items-center gap-3 border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-2 py-2"
                        >
                          <div className="h-2 w-2 shrink-0 animate-pulse bg-[var(--color-border-strong)]" />
                          <div className="h-3 flex-1 animate-pulse bg-[var(--color-bg-primary)]" />
                          <div className="h-3 w-12 animate-pulse bg-[var(--color-bg-primary)]" />
                        </div>
                      ))}
                    </div>
                  ) : visibleSessions.length > 0 ? (
                    visibleSessions.map((session) => {
                      const level = getAttentionLevel(session);
                      const isSessionActive = activeSessionId === session.id;
                      // Display precedence: optimistic rename (just-saved value)
                      // → user-set displayName → branch → fallback chain.
                      // Auto-derived displayName (displayNameUserSet=false) is
                      // intentionally skipped here so PR/issue titles surfaced
                      // by getSessionTitle aren't shadowed — mirrors the gate in
                      // format.ts:getSessionTitle.
                      const pending = pendingRenames.get(session.id);
                      const effectiveDisplayName =
                        pending !== undefined
                          ? pending
                          : session.displayNameUserSet
                            ? (session.displayName ?? "")
                            : "";
                      const title =
                        effectiveDisplayName !== ""
                          ? effectiveDisplayName
                          : (session.branch ?? getSessionTitle(session));
                      const sessionHref = projectSessionPath(project.id, session.id);
                      const isEditing = editingSessionId === session.id;
                      if (isEditing) {
                        return (
                          <div
                            key={session.id}
                            className={cn(
                              "project-sidebar__sess-row",
                              isSessionActive && "project-sidebar__sess-row--active",
                            )}
                            data-editing="true"
                          >
                            <SessionDot level={level} />
                            <input
                              type="text"
                              autoFocus
                              value={editingValue}
                              onChange={(e) => setEditingValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  void submitRename(session.id);
                                } else if (e.key === "Escape") {
                                  e.preventDefault();
                                  cancelRename();
                                }
                              }}
                              onFocus={(e) => e.currentTarget.select()}
                              onBlur={() => void submitRename(session.id)}
                              maxLength={80}
                              aria-label={`Rename ${session.id}`}
                              className="project-sidebar__sess-rename-input"
                            />
                          </div>
                        );
                      }
                      return (
                        <div
                          key={session.id}
                          className={cn(
                            "project-sidebar__sess-row group",
                            isSessionActive && "project-sidebar__sess-row--active",
                          )}
                        >
                          <a
                            href={sessionHref}
                            onClick={(e) => {
                              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
                              e.preventDefault();
                              navigate(sessionHref, session);
                            }}
                            className="project-sidebar__sess-link flex flex-1 min-w-0 items-center gap-[7px]"
                            aria-current={isSessionActive ? "page" : undefined}
                            aria-label={`Open ${title}`}
                          >
                            <SessionDot level={level} />
                            <div className="flex-1 min-w-0">
                              <span
                                className={cn(
                                  "project-sidebar__sess-label",
                                  isSessionActive && "project-sidebar__sess-label--active",
                                )}
                              >
                                {title}
                              </span>
                              {showSessionId ? (
                                <div className="project-sidebar__sess-meta">
                                  <span className="project-sidebar__sess-id">{session.id}</span>
                                  <span className="project-sidebar__sess-status">
                                    {LEVEL_LABELS[level]}
                                  </span>
                                </div>
                              ) : null}
                            </div>
                            {!showSessionId ? (
                              <span className="project-sidebar__sess-status project-sidebar__sess-status--inline">
                                {LEVEL_LABELS[level]}
                              </span>
                            ) : null}
                          </a>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              startRename(session, title);
                            }}
                            className="project-sidebar__sess-rename-btn opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100"
                            title="Rename session"
                            aria-label={`Rename ${session.id}`}
                          >
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M12 20h9" />
                              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                            </svg>
                          </button>
                        </div>
                      );
                    })
                  ) : error ? (
                    <div className="px-3 py-2">
                      <div className="project-sidebar__empty">Failed to load sessions</div>
                      <button
                        type="button"
                        className="mt-2 text-xs font-medium text-[var(--color-link)] hover:underline"
                        onClick={onRetry}
                      >
                        Retry
                      </button>
                    </div>
                  ) : (
                    <div className="project-sidebar__empty">No sessions shown</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="project-sidebar__footer">
        <div className="flex items-center gap-1 border-t border-[var(--color-border-subtle)] px-2 py-2">
          {/* Show killed toggle */}
          <button
            type="button"
            onClick={() => setShowKilled(!showKilled)}
            className={cn(
              "project-sidebar__footer-btn",
              showKilled && "project-sidebar__footer-btn--active",
            )}
            aria-pressed={showKilled}
            title={showKilled ? "Hide killed sessions" : "Show killed sessions"}
            aria-label={showKilled ? "Hide killed sessions" : "Show killed sessions"}
          >
            {/* skull / terminated icon */}
            <svg
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M12 3C7.03 3 3 7.03 3 12c0 3.1 1.5 5.84 3.8 7.55V21h2.4v-1h1.6v1h2.4v-1h1.6v1H17v-1.45A9 9 0 0 0 21 12c0-4.97-4.03-9-9-9z" />
              <circle cx="9" cy="11" r="1.5" fill="currentColor" stroke="none" />
              <circle cx="15" cy="11" r="1.5" fill="currentColor" stroke="none" />
            </svg>
          </button>
          {/* Show done toggle */}
          <button
            type="button"
            onClick={() => setShowDone(!showDone)}
            className={cn(
              "project-sidebar__footer-btn",
              showDone && "project-sidebar__footer-btn--active",
            )}
            aria-pressed={showDone}
            title={showDone ? "Hide completed sessions" : "Show completed sessions"}
            aria-label={showDone ? "Hide completed sessions" : "Show completed sessions"}
          >
            {/* checkmark / done icon */}
            <svg
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </button>
          <div className="flex-1" />
          {/* Sidebar display settings (gear) */}
          <div className="project-sidebar__settings-wrap" ref={settingsRef}>
            <button
              type="button"
              onClick={() => setSettingsOpen((v) => !v)}
              className={cn(
                "project-sidebar__footer-btn",
                settingsOpen && "project-sidebar__footer-btn--active",
              )}
              aria-expanded={settingsOpen}
              aria-haspopup="dialog"
              title="Sidebar settings"
              aria-label="Sidebar settings"
            >
              <svg
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            {settingsOpen ? (
              <div
                ref={settingsPopoverRef}
                className="project-sidebar__settings-popover"
                role="dialog"
                aria-label="Sidebar settings"
              >
                <label className="project-sidebar__settings-row">
                  <input
                    type="checkbox"
                    checked={showSessionId}
                    onChange={(e) => setShowSessionId(e.target.checked)}
                  />
                  <span>Show session ID</span>
                </label>
              </div>
            ) : null}
          </div>
          <ThemeToggle className="project-sidebar__theme-toggle" />
        </div>
      </div>
      <AddProjectModal open={addProjectOpen} onClose={() => setAddProjectOpen(false)} />
      <ProjectSettingsModal
        open={projectSettingsProjectId !== null}
        projectId={projectSettingsProjectId}
        onClose={() => setProjectSettingsProjectId(null)}
      />
    </aside>
  );
}
