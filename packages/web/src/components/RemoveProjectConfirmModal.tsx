"use client";

import { useEffect, useRef } from "react";
import type { ProjectInfo } from "@/lib/project-name";

export const REMOVE_PROJECT_CONFIRM_MESSAGE =
  "This clears its AO sessions/history and removes it from the portfolio, but keeps the repository folder on disk.";

interface RemoveProjectConfirmModalProps {
  project: ProjectInfo | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function RemoveProjectConfirmModal({
  project,
  busy,
  onCancel,
  onConfirm,
}: RemoveProjectConfirmModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!project) return;
    modalRef.current?.focus();
  }, [project]);

  useEffect(() => {
    if (!project) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [project, busy, onCancel]);

  if (!project) return null;

  return (
    <div className="project-settings-modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-project-title"
        className="project-settings-modal project-settings-modal--confirm"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-settings-modal__header">
          <div>
            <p className="project-settings-modal__eyebrow">Remove project</p>
            <h2 id="remove-project-title" className="project-settings-modal__title">
              Remove {project.name}?
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onCancel}
            disabled={busy}
            className="project-settings-modal__close"
          >
            ×
          </button>
        </div>

        <p className="project-settings-modal__confirm-body">{REMOVE_PROJECT_CONFIRM_MESSAGE}</p>

        <div className="project-settings-modal__confirm-actions">
          <button
            type="button"
            className="bottom-sheet__btn bottom-sheet__btn--cancel"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="bottom-sheet__btn bottom-sheet__btn--danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Removing…" : "Remove from AO"}
          </button>
        </div>
      </div>
    </div>
  );
}
