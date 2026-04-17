"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import type { DashboardSession } from "@/lib/types";

export interface SpawnSessionModalProps {
  projectId: string;
  projectName?: string;
  open: boolean;
  onClose: () => void;
  onSpawned?: (sessionId: string) => void;
  onSessionCreated?: (session: DashboardSession) => void;
}

export function SpawnSessionModal({
  projectId,
  projectName,
  open,
  onClose,
  onSpawned,
  onSessionCreated,
}: SpawnSessionModalProps) {
  const router = useRouter();
  const [issueId, setIssueId] = useState("");
  const [introPrompt, setIntroPrompt] = useState("");
  const [agent, setAgent] = useState("");
  const [agents, setAgents] = useState<{ name: string; description?: string }[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [basePromptMode, setBasePromptMode] = useState<"default" | "planning" | "custom">(
    "default",
  );
  const [customBasePrompt, setCustomBasePrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSubmitting(false);
    setAgentsLoading(true);

    // Fetch available agents
    void (async () => {
      try {
        const res = await fetch("/api/agents");
        const data = (await res.json().catch(() => null)) as { agents?: { name: string }[] } | null;
        const list = data?.agents ?? [];
        setAgents(list);
        setAgent((current) => {
          if (current && list.some((a) => a.name === current)) return current;
          return list[0]?.name ?? "";
        });
      } catch {
        setAgents([]);
        setAgent("");
      } finally {
        setAgentsLoading(false);
      }
    })();

    // Fetch base prompt text to pre-fill the custom textarea
    void (async () => {
      try {
        const res = await fetch("/api/base-prompt");
        const data = (await res.json().catch(() => null)) as { text?: string } | null;
        const text = data?.text ?? "";
        setCustomBasePrompt((prev) => (prev ? prev : text));
      } catch {
        // Non-fatal — custom textarea stays empty until user types
      }
    })();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = requestAnimationFrame(() => firstFieldRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      // Build request body before closing dialog (capture form state)
      const body: {
        projectId: string;
        issueId?: string;
        agent?: string;
        prompt?: string;
        basePromptMode?: "planning" | "custom";
        basePromptCustom?: string;
      } = { projectId };

      const trimmedIssue = issueId.trim();
      if (trimmedIssue) body.issueId = trimmedIssue;
      if (agent.trim()) body.agent = agent.trim();
      const trimmedPrompt = introPrompt.trim();
      if (trimmedPrompt) body.prompt = trimmedPrompt;

      if (basePromptMode !== "default") {
        body.basePromptMode = basePromptMode;
      }
      if (basePromptMode === "custom" && customBasePrompt.trim()) {
        body.basePromptCustom = customBasePrompt.trim();
      }

      // Optimistic: close dialog immediately, show stub in sidebar
      const stubId = `spawning-${Date.now()}`;
      const stub: DashboardSession = {
        id: stubId,
        projectId,
        status: "working",
        activity: null,
        branch: null,
        issueId: trimmedIssue || null,
        issueUrl: null,
        issueLabel: null,
        issueTitle: null,
        userPrompt: trimmedPrompt || null,
        summary: null,
        summaryIsFallback: false,
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        pr: null,
        metadata: {},
      };

      onSessionCreated?.(stub);
      onClose();
      setIssueId("");
      setIntroPrompt("");
      setBasePromptMode("default");

      // Spawn in background — navigate to real session when ready
      try {
        const res = await fetch("/api/spawn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => null)) as
          | { session?: DashboardSession; error?: string }
          | null;
        if (!res.ok) {
          console.error("[SpawnSession] Spawn failed:", data?.error ?? `HTTP ${res.status}`);
          return;
        }
        const realSession = data?.session;
        if (realSession?.id) {
          onSessionCreated?.(realSession);
          onSpawned?.(realSession.id);
          router.push(
            `/sessions/${encodeURIComponent(realSession.id)}?project=${encodeURIComponent(projectId)}`,
          );
        }
      } catch (err) {
        console.error("[SpawnSession] Spawn error:", err);
      }
    },
    [
      projectId,
      issueId,
      introPrompt,
      agent,
      basePromptMode,
      customBasePrompt,
      onClose,
      onSpawned,
      onSessionCreated,
      router,
    ],
  );

  if (typeof document === "undefined" || !open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="spawn-modal-title"
        className="flex w-full max-w-md flex-col rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] shadow-xl"
        style={{ maxHeight: "calc(100dvh - 2rem)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex shrink-0 items-start justify-between gap-3 px-5 pt-5">
          <h2
            id="spawn-modal-title"
            className="text-[15px] font-semibold text-[var(--color-text-primary)]"
          >
            Spawn session
            {projectName ? (
              <>
                {" "}
                in <span className="text-[var(--color-accent-amber)]">{projectName}</span>
              </>
            ) : null}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)]"
            aria-label="Close"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 pb-5">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">
              Issue ID (optional)
            </span>
            <input
              ref={firstFieldRef}
              type="text"
              value={issueId}
              onChange={(e) => setIssueId(e.target.value)}
              placeholder="e.g. INT-123"
              className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[13px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
              autoComplete="off"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">
              Intro prompt (optional)
            </span>
            <span className="mb-1.5 block text-[10px] leading-snug text-[var(--color-text-tertiary)] opacity-90">
              Session-specific instructions — same as{" "}
              <code className="font-mono">ao spawn --prompt</code>. Shown early in the agent prompt.
            </span>
            <textarea
              value={introPrompt}
              onChange={(e) => setIntroPrompt(e.target.value)}
              placeholder="e.g. Focus on the API layer first; keep commits small."
              rows={4}
              className="w-full resize-y rounded border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[13px] leading-relaxed text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
              autoComplete="off"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">
              Agent
            </span>
            <select
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              disabled={agentsLoading || agents.length === 0}
              className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[13px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)] disabled:opacity-60"
            >
              {agents.length === 0 ? (
                <option value="">No agents available</option>
              ) : (
                agents.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                    {a.description ? ` — ${a.description}` : ""}
                  </option>
                ))
              )}
            </select>
          </label>

          {/* Base Prompt Mode */}
          <div>
            <label
              htmlFor="basePromptMode"
              className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]"
            >
              Base Prompt
            </label>
            <select
              id="basePromptMode"
              value={basePromptMode}
              onChange={(e) =>
                setBasePromptMode(e.target.value as "default" | "planning" | "custom")
              }
              className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[13px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
            >
              <option value="default">Default (standard agent behavior)</option>
              <option value="planning">Planning (write plan, wait for approval)</option>
              <option value="custom">Custom</option>
            </select>
          </div>

          {basePromptMode === "custom" && (
            <div>
              <label
                htmlFor="customBasePrompt"
                className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]"
              >
                Custom Base Prompt
              </label>
              <textarea
                id="customBasePrompt"
                value={customBasePrompt}
                onChange={(e) => setCustomBasePrompt(e.target.value)}
                rows={8}
                className="w-full resize-y rounded border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 font-mono text-[12px] leading-relaxed text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                style={{ maxHeight: "16rem", overflowY: "auto" }}
                placeholder="Enter a custom base prompt (replaces the default AO system instructions)..."
              />
              <p className="mt-1 text-[10px] text-[var(--color-text-tertiary)]">
                Replaces the default AO system instructions. Pre-filled with the default text.
              </p>
            </div>
          )}

          {error ? (
            <p className="text-[12px] text-[var(--color-status-error)]" role="alert">
              {error}
            </p>
          ) : null}

          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-subtle)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || agentsLoading || agents.length === 0}
              className={cn(
                "rounded px-3 py-1.5 text-[12px] font-medium text-white",
                submitting || agentsLoading || agents.length === 0
                  ? "cursor-not-allowed bg-[var(--color-text-tertiary)]"
                  : "bg-[var(--color-accent-amber)] hover:opacity-90",
              )}
            >
              {submitting ? "Spawning…" : "Spawn"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
