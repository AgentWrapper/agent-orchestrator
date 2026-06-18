"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  deriveProjectIdFromPath,
  deriveProjectNameFromPath,
  joinBrowsePath,
} from "@/components/AddProjectModal.parts";
import { DirectoryBrowser } from "@/components/DirectoryBrowser";
import { useDirectoryBrowser } from "@/hooks/useDirectoryBrowser";

interface CollisionState {
  error: string;
  existingProjectId: string;
  suggestedProjectId: string;
  suggestion: "choose-project-id";
}

interface AddProjectModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddProjectModal({ open, onClose }: AddProjectModalProps) {
  const router = useRouter();
  const browser = useDirectoryBrowser();
  const modalRef = useRef<HTMLDivElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [collision, setCollision] = useState<CollisionState | null>(null);
  const [projectIdInput, setProjectIdInput] = useState("");
  const [projectNameInput, setProjectNameInput] = useState("");

  const {
    reset,
    selectedBrowsePath,
    directoryEntries,
    currentDirectory,
    error: browseError,
    browsePath,
  } = browser;

  useEffect(() => {
    if (!open) return;
    setSubmitting(false);
    setInlineError(null);
    setNetworkError(null);
    setCollision(null);
    setProjectIdInput("");
    setProjectNameInput("");
    modalRef.current?.focus();
    reset();
  }, [open, reset]);

  const selectedEntry = useMemo(
    () =>
      directoryEntries.find(
        (entry) => joinBrowsePath(browsePath, entry.name) === selectedBrowsePath,
      ) ?? null,
    [browsePath, directoryEntries, selectedBrowsePath],
  );
  const selectedCurrentDirectory = selectedBrowsePath === browsePath ? currentDirectory : null;
  const projectIdValue =
    projectIdInput.trim() ||
    (selectedBrowsePath.trim() && selectedBrowsePath !== "~"
      ? deriveProjectIdFromPath(selectedBrowsePath)
      : "");
  const projectNameValue =
    projectNameInput.trim() ||
    (selectedBrowsePath.trim() && selectedBrowsePath !== "~"
      ? deriveProjectNameFromPath(selectedBrowsePath)
      : "");
  const canSubmit =
    selectedBrowsePath.trim() !== "" &&
    selectedBrowsePath !== "~" &&
    !browseError &&
    Boolean(selectedEntry?.isGitRepo || selectedCurrentDirectory?.isGitRepo) &&
    projectIdValue.length > 0 &&
    projectNameValue.length > 0;

  useEffect(() => {
    if (!selectedBrowsePath || selectedBrowsePath === "~") {
      setProjectIdInput("");
      setProjectNameInput("");
      return;
    }

    setProjectIdInput(deriveProjectIdFromPath(selectedBrowsePath));
    setProjectNameInput(deriveProjectNameFromPath(selectedBrowsePath));
  }, [selectedBrowsePath]);

  const submit = useCallback(
    async (useDefaultProjectId = false) => {
      setInlineError(null);
      setNetworkError(null);
      setCollision(null);
      setSubmitting(true);
      const resolvedPath = selectedBrowsePath.trim();
      const projectId = projectIdValue;
      const name = projectNameValue;
      try {
        const response = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, name, path: resolvedPath, useDefaultProjectId }),
        });
        const body = (await response.json().catch(() => null)) as {
          error?: string;
          projectId?: string;
          existingProjectId?: string;
          suggestedProjectId?: string;
          suggestion?: "choose-project-id";
        } | null;
        if (
          response.status === 409 &&
          body?.existingProjectId &&
          body?.suggestedProjectId &&
          body?.suggestion
        ) {
          setCollision({
            error: body.error ?? "A project with that ID already exists.",
            existingProjectId: body.existingProjectId,
            suggestedProjectId: body.suggestedProjectId,
            suggestion: body.suggestion,
          });
          setProjectIdInput(body.suggestedProjectId);
          return;
        }
        if (!response.ok) {
          const message = body?.error ?? "Failed to add project.";
          if (response.status < 500) setInlineError(message);
          else setNetworkError(message);
          return;
        }
        const nextProjectId = body?.projectId ?? projectId.trim();
        onClose();
        router.push(`/projects/${encodeURIComponent(nextProjectId)}`);
        router.refresh();
      } catch {
        setNetworkError("Network error while adding project.");
      } finally {
        setSubmitting(false);
      }
    },
    [onClose, projectIdValue, projectNameValue, router, selectedBrowsePath],
  );

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !modalRef.current?.contains(document.activeElement) &&
        document.activeElement !== document.body
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSubmit) {
        event.preventDefault();
        void submit();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [canSubmit, onClose, open, submit]);

  if (!open) return null;

  const selectedIsKnownNonRepo =
    Boolean(selectedEntry && !selectedEntry.isGitRepo) ||
    Boolean(
      selectedCurrentDirectory && selectedBrowsePath !== "~" && !selectedCurrentDirectory.isGitRepo,
    );

  const selectedNotice = collision ? (
    <div className="add-project-modal__notice add-project-modal__notice--warning">
      <p className="add-project-modal__notice-title">{collision.error}</p>
      <p className="add-project-modal__notice-copy">
        Existing project: <code>{collision.existingProjectId}</code>
      </p>
      <p className="add-project-modal__notice-copy">
        Suggested project ID: <code>{collision.suggestedProjectId}</code>
      </p>
      <div className="add-project-modal__notice-actions">
        <button
          type="button"
          onClick={() => {
            onClose();
            router.push(`/projects/${encodeURIComponent(collision.existingProjectId)}`);
          }}
          className="add-project-modal__ghostbtn"
        >
          Open existing
        </button>
        <button
          type="button"
          onClick={() => void submit(true)}
          className="add-project-modal__ghostbtn"
        >
          Use suggested ID
        </button>
        <span className="add-project-modal__notice-hint">
          Edit the Project ID field or accept the suggested suffix.
        </span>
      </div>
    </div>
  ) : inlineError ? (
    <div role="alert" className="add-project-modal__notice add-project-modal__notice--error">
      {inlineError}
    </div>
  ) : selectedIsKnownNonRepo ? (
    <div role="alert" className="add-project-modal__notice add-project-modal__notice--error">
      Selected folder is not a git repository.
    </div>
  ) : networkError ? (
    <div className="add-project-modal__notice add-project-modal__notice--error">{networkError}</div>
  ) : null;

  return (
    <div className="add-project-modal-backdrop">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add project"
        className="add-project-modal"
        tabIndex={-1}
      >
        <div className="add-project-modal__titlebar">
          <h2 className="add-project-modal__windowtitle">add project</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="add-project-modal__iconbtn"
          >
            ×
          </button>
        </div>

        <DirectoryBrowser browser={browser} />

        <div className="add-project-modal__pathbar add-project-modal__pathbar--selection">
          <span className="add-project-modal__selection-label">Selected</span>
          <span className="add-project-modal__selection-path">
            {selectedBrowsePath || "No directory selected"}
          </span>
        </div>
        <div className="add-project-modal__pathbar add-project-modal__formrow">
          <div className="add-project-modal__field">
            <label className="add-project-modal__selection-label" htmlFor="project-id-input">
              Project ID
            </label>
            <input
              id="project-id-input"
              value={projectIdInput}
              onChange={(event) => setProjectIdInput(event.target.value)}
              className="add-project-modal__selection-path"
            />
          </div>
          <div className="add-project-modal__field">
            <label className="add-project-modal__selection-label" htmlFor="project-name-input">
              Project name
            </label>
            <input
              id="project-name-input"
              value={projectNameInput}
              onChange={(event) => setProjectNameInput(event.target.value)}
              className="add-project-modal__selection-path"
            />
          </div>
        </div>
        {selectedNotice}

        <div className="add-project-modal__footer">
          <div className="add-project-modal__foldercount">{directoryEntries.length} folders</div>
          <div className="add-project-modal__actions">
            <button type="button" onClick={onClose} className="add-project-modal__ghostbtn">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit || submitting}
              className="add-project-modal__primarybtn"
            >
              {submitting ? "Adding…" : "Add project"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
