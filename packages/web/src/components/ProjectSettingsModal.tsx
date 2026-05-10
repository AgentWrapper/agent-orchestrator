"use client";

import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ProjectSettingsForm } from "@/components/ProjectSettingsForm";
import { useFocusTrap } from "@/hooks/useFocusTrap";

interface ProjectSettingsModalProps {
  open: boolean;
  projectId: string | null;
  onClose: () => void;
}

interface ProjectSettingsResponse {
  project: {
    id: string;
    name: string;
    path: string;
    repo?: string;
    defaultBranch?: string;
    agent?: string;
    runtime?: string;
    tracker?: { plugin?: string };
    scm?: { plugin?: string };
    reactions?: Record<string, unknown>;
  };
  error?: string;
  degraded?: boolean;
}

export function ProjectSettingsModal({ open, projectId, onClose }: ProjectSettingsModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const backdropPointerStartedRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectSettingsResponse["project"] | null>(null);
  useFocusTrap(Boolean(open && projectId), modalRef);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !projectId) {
      setProject(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setProject(null);

    void fetch(`/api/projects/${encodeURIComponent(projectId)}`)
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as ProjectSettingsResponse | null;
        if (!response.ok || !body?.project || body.degraded) {
          throw new Error(body?.error ?? "Failed to load project settings.");
        }
        if (!cancelled) {
          setProject(body.project);
        }
      })
      .catch((fetchError) => {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : "Failed to load project settings.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const initialValues = useMemo(() => {
    if (!project || !projectId) return null;
    return {
      agent: project.agent ?? "",
      runtime: project.runtime ?? "",
      trackerPlugin: project.tracker?.plugin ?? "",
      scmPlugin: project.scm?.plugin ?? "",
      reactions: JSON.stringify(project.reactions ?? {}, null, 2),
      identity: {
        projectId,
        path: project.path,
        repo: project.repo ?? "",
        defaultBranch: project.defaultBranch ?? "main",
      },
    };
  }, [project, projectId]);

  if (!open || !projectId || typeof document === "undefined") return null;

  const handleBackdropPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    backdropPointerStartedRef.current = event.target === event.currentTarget;
  };

  const handleBackdropPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const releaseTarget = document.elementFromPoint(event.clientX, event.clientY);
    const shouldClose = backdropPointerStartedRef.current && releaseTarget === event.currentTarget;
    backdropPointerStartedRef.current = false;
    if (shouldClose) onClose();
  };

  const handleBackdropPointerCancel = () => {
    backdropPointerStartedRef.current = false;
  };

  const handleDialogPointerEvent = (event: PointerEvent<HTMLDivElement>) => {
    backdropPointerStartedRef.current = false;
    event.stopPropagation();
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return createPortal(
    <div
      className="project-settings-modal-backdrop"
      onPointerDown={handleBackdropPointerDown}
      onPointerUp={handleBackdropPointerUp}
      onPointerCancel={handleBackdropPointerCancel}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Project settings"
        className="project-settings-modal"
        tabIndex={-1}
        onPointerDown={handleDialogPointerEvent}
        onPointerUp={handleDialogPointerEvent}
        onPointerCancel={handleDialogPointerEvent}
        onKeyDown={handleDialogKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-settings-modal__header">
          <div>
            <p className="project-settings-modal__eyebrow">Project settings</p>
            <h2 className="project-settings-modal__title">{project?.name ?? projectId}</h2>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="project-settings-modal__close"
          >
            ×
          </button>
        </div>

        <div className="project-settings-modal__body">
          {loading ? <div className="project-settings-modal__state">Loading project settings…</div> : null}
          {!loading && error ? (
            <div role="alert" className="project-settings-modal__state project-settings-modal__state--error">
              {error}
            </div>
          ) : null}
          {!loading && !error && initialValues ? (
            <ProjectSettingsForm projectId={projectId} initialValues={initialValues} />
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
