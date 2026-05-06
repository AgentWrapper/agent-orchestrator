"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ToastProvider, useToast } from "@/components/Toast";

const IDENTITY_FIELD_TOOLTIP =
  "These describe which repo this is. Change them via `ao project relink`.";

interface ProjectSettingsFormProps {
  projectId: string;
  initialValues: {
    agent: string;
    runtime: string;
    trackerPlugin: string;
    scmPlugin: string;
    reactions: string;
    identity: {
      projectId: string;
      path: string;
      repo: string;
      defaultBranch: string;
    };
  };
}

function ProjectSettingsFormInner({ projectId, initialValues }: ProjectSettingsFormProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [agent, setAgent] = useState(initialValues.agent);
  const [runtime, setRuntime] = useState(initialValues.runtime);
  const [trackerPlugin, setTrackerPlugin] = useState(initialValues.trackerPlugin);
  const [scmPlugin, setScmPlugin] = useState(initialValues.scmPlugin);
  const [reactions, setReactions] = useState(initialValues.reactions);
  const [submitting, setSubmitting] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);

  const behaviorPayload = useMemo(
    () => ({
      agent: agent.trim() || null,
      runtime: runtime.trim() || null,
      tracker: trackerPlugin.trim() ? { plugin: trackerPlugin.trim() } : null,
      scm: scmPlugin.trim() ? { plugin: scmPlugin.trim() } : null,
      reactions,
    }),
    [agent, runtime, trackerPlugin, scmPlugin, reactions],
  );

  const submit = async () => {
    setInlineError(null);
    setNetworkError(null);

    let parsedReactions: Record<string, unknown> | undefined;
    try {
      const trimmed = reactions.trim();
      parsedReactions = trimmed ? (JSON.parse(trimmed) as Record<string, unknown>) : undefined;
    } catch {
      setInlineError("Reactions must be valid JSON.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: behaviorPayload.agent,
          runtime: behaviorPayload.runtime,
          tracker: behaviorPayload.tracker,
          scm: behaviorPayload.scm,
          reactions: parsedReactions ?? null,
        }),
      });

      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        const errorMessage = body?.error ?? "Failed to save project settings.";
        if (response.status === 400) {
          setInlineError(errorMessage);
        } else {
          setNetworkError(errorMessage);
        }
        return;
      }

      showToast("Project settings updated.", "success");
      router.refresh();
    } catch {
      setNetworkError("Network error while saving project settings.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="project-settings-form">
      <section className="project-settings-form__section">
        <div className="project-settings-form__section-header">
          <div>
            <p className="project-settings-form__eyebrow">
              Behavior
            </p>
            <h2 className="project-settings-form__section-title">Runtime configuration</h2>
            <p className="project-settings-form__section-copy">
              These values change how AO runs this project without changing which repository the project points at.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            className="project-settings-form__save"
          >
            {submitting ? "Saving..." : "Save changes"}
          </button>
        </div>

        <div className="project-settings-form__grid">
          <EditableField
            id="agent"
            label="Agent"
            value={agent}
            onChange={setAgent}
            placeholder="claude-code"
          />
          <EditableField
            id="runtime"
            label="Runtime"
            value={runtime}
            onChange={setRuntime}
            placeholder="tmux"
          />
          <EditableField
            id="tracker-plugin"
            label="Tracker plugin"
            value={trackerPlugin}
            onChange={setTrackerPlugin}
            placeholder="github"
          />
          <EditableField
            id="scm-plugin"
            label="SCM plugin"
            value={scmPlugin}
            onChange={setScmPlugin}
            placeholder="github"
          />
        </div>

        <div className="project-settings-form__reactions">
          <label htmlFor="reactions" className="project-settings-form__label">
            Reactions
          </label>
          <p className="project-settings-form__hint">
            JSON object keyed by reaction name. This PATCH only sends behavior fields.
          </p>
          <textarea
            id="reactions"
            value={reactions}
            onChange={(event) => setReactions(event.target.value)}
            spellCheck={false}
            rows={12}
            className="project-settings-form__textarea project-settings-form__textarea--mono"
          />
        </div>

        {inlineError ? (
          <div
            role="alert"
            className="project-settings-form__alert project-settings-form__alert--error"
          >
            {inlineError}
          </div>
        ) : null}

        {networkError ? (
          <div className="project-settings-form__alert project-settings-form__alert--surface">
            <p className="project-settings-form__alert-copy">{networkError}</p>
            <button
              type="button"
              onClick={() => void submit()}
              className="project-settings-form__retry"
            >
              Retry
            </button>
          </div>
        ) : null}
      </section>

      <section className="project-settings-form__section">
        <p className="project-settings-form__eyebrow">
          Identity
        </p>
        <h2 className="project-settings-form__section-title">Repository identity</h2>
        <p className="project-settings-form__section-copy">
          These fields are read-only because they define which repository AO considers this project to be.
        </p>

        <div className="project-settings-form__grid">
          <ReadonlyField id="identity-project-id" label="Project ID" value={initialValues.identity.projectId} />
          <ReadonlyField id="identity-path" label="Path" value={initialValues.identity.path} />
          <ReadonlyField id="identity-repo" label="Repo" value={initialValues.identity.repo} />
          <ReadonlyField
            id="identity-default-branch"
            label="Default branch"
            value={initialValues.identity.defaultBranch}
          />
        </div>
      </section>
    </div>
  );
}

function EditableField({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label htmlFor={id} className="project-settings-form__field">
      <span className="project-settings-form__label">{label}</span>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="project-settings-form__input"
      />
    </label>
  );
}

function ReadonlyField({
  id,
  label,
  value,
}: {
  id: string;
  label: string;
  value: string;
}) {
  return (
    <label htmlFor={id} className="project-settings-form__field">
      <span className="project-settings-form__label">{label}</span>
      <input
        id={id}
        value={value}
        disabled
        readOnly
        title={IDENTITY_FIELD_TOOLTIP}
        aria-describedby={`${id}-tooltip`}
        className="project-settings-form__input project-settings-form__input--readonly"
      />
      <span id={`${id}-tooltip`} className="project-settings-form__hint">
        {IDENTITY_FIELD_TOOLTIP}
      </span>
    </label>
  );
}

export function ProjectSettingsForm(props: ProjectSettingsFormProps) {
  return (
    <ToastProvider>
      <ProjectSettingsFormInner {...props} />
    </ToastProvider>
  );
}
