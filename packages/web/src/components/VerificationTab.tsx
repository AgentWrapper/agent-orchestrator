"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Issue } from "@aoagents/ao-core";

type VerificationIssue = Issue & { projectId: string };
type VerificationAction = "verify" | "fail";

interface VerificationTabProps {
  projectId?: string;
  projects?: Array<{ id: string; name: string }>;
  active: boolean;
}

function getProjectLabel(projectId: string, projects: Array<{ id: string; name: string }>): string {
  return projects.find((project) => project.id === projectId)?.name ?? projectId;
}

export function VerificationTab({ projectId, projects = [], active }: VerificationTabProps) {
  const [issues, setIssues] = useState<VerificationIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatingIssueId, setUpdatingIssueId] = useState<string | null>(null);

  const scopedIssues = useMemo(
    () => (projectId ? issues.filter((issue) => issue.projectId === projectId) : issues),
    [issues, projectId],
  );

  const loadIssues = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/verify");
      const body = (await response.json().catch(() => null)) as
        | { issues?: VerificationIssue[]; error?: string }
        | null;
      if (!response.ok) {
        throw new Error(body?.error ?? "검증 대기 목록을 불러오지 못했습니다.");
      }
      setIssues(body?.issues ?? []);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "검증 대기 목록을 불러오지 못했습니다.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void loadIssues();
  }, [active, loadIssues]);

  const updateIssue = async (issue: VerificationIssue, action: VerificationAction) => {
    setUpdatingIssueId(issue.id);
    setError(null);
    try {
      const response = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issueId: issue.id,
          projectId: issue.projectId,
          action,
        }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(body?.error ?? "검증 상태를 업데이트하지 못했습니다.");
      }
      setIssues((current) =>
        current.filter(
          (currentIssue) =>
            currentIssue.id !== issue.id || currentIssue.projectId !== issue.projectId,
        ),
      );
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : "검증 상태를 업데이트하지 못했습니다.",
      );
    } finally {
      setUpdatingIssueId(null);
    }
  };

  return (
    <section className="mx-auto max-w-[960px]" aria-labelledby="verification-tab-title">
      <div className="mb-4 flex flex-col gap-2 border-b border-[var(--color-border-subtle)] pb-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h2
            id="verification-tab-title"
            className="text-[17px] font-semibold text-[var(--color-text-primary)]"
          >
            검증
          </h2>
          <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
            병합 후 스테이징 확인이 필요한 이슈를 처리합니다.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadIssues()}
          disabled={loading}
          className="inline-flex items-center justify-center border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] disabled:cursor-wait disabled:opacity-60"
        >
          {loading ? "새로고침 중" : "새로고침"}
        </button>
      </div>

      {error ? (
        <div
          className="mb-4 border border-[color-mix(in_srgb,var(--color-status-error)_28%,transparent)] bg-[color-mix(in_srgb,var(--color-status-error)_10%,transparent)] px-3.5 py-2.5 text-[12px] text-[var(--color-status-error)]"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      {loading && scopedIssues.length === 0 ? (
        <div className="border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-4 py-6 text-[12px] text-[var(--color-text-secondary)]">
          검증 대기 목록을 불러오는 중입니다.
        </div>
      ) : null}

      {!loading && scopedIssues.length === 0 ? (
        <div className="border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-4 py-6 text-[12px] text-[var(--color-text-secondary)]">
          검증 대기 중인 이슈가 없습니다.
        </div>
      ) : null}

      {scopedIssues.length > 0 ? (
        <div className="space-y-2">
          {scopedIssues.map((issue) => {
            const updating = updatingIssueId === issue.id;
            return (
              <article
                key={`${issue.projectId}:${issue.id}`}
                className="border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-4 py-3"
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-[10.5px] text-[var(--color-text-muted)]">
                      <span className="font-mono">{issue.id}</span>
                      <span>{getProjectLabel(issue.projectId, projects)}</span>
                    </div>
                    <a
                      href={issue.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[13px] font-semibold text-[var(--color-text-primary)] hover:text-[var(--color-accent)]"
                    >
                      {issue.title}
                    </a>
                    {issue.labels.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {issue.labels.map((label) => (
                          <span
                            key={label}
                            className="border border-[var(--color-border-subtle)] bg-[var(--color-chip-bg)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      disabled={updating}
                      onClick={() => void updateIssue(issue, "verify")}
                      className="border border-[color-mix(in_srgb,var(--color-status-success)_38%,transparent)] bg-[color-mix(in_srgb,var(--color-status-success)_10%,transparent)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-status-success)] disabled:cursor-wait disabled:opacity-60"
                    >
                      검증 완료
                    </button>
                    <button
                      type="button"
                      disabled={updating}
                      onClick={() => void updateIssue(issue, "fail")}
                      className="border border-[color-mix(in_srgb,var(--color-status-error)_32%,transparent)] bg-[color-mix(in_srgb,var(--color-status-error)_9%,transparent)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-status-error)] disabled:cursor-wait disabled:opacity-60"
                    >
                      실패 처리
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
