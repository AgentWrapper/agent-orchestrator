"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Issue } from "@aoagents/ao-core";
import { CI_STATUS, type DashboardCICheck, type DashboardSession } from "@/lib/types";

type VerificationIssue = Issue & { projectId: string };
type VerificationAction = "verify" | "fail";
type VerificationTone = "ok" | "warn" | "error" | "muted";

interface VerificationTabProps {
  projectId?: string;
  projects?: Array<{ id: string; name: string }>;
  sessions?: DashboardSession[];
  active: boolean;
}

function getProjectLabel(projectId: string, projects: Array<{ id: string; name: string }>): string {
  return projects.find((project) => project.id === projectId)?.name ?? projectId;
}

function normalizeIssueKey(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.trim().toLowerCase().replace(/^#/, "");
}

function findIssueSession(
  issue: VerificationIssue,
  sessions: DashboardSession[],
): DashboardSession | null {
  const issueKeys = new Set(
    [issue.id, issue.url]
      .map((value) => normalizeIssueKey(value))
      .filter((value): value is string => Boolean(value)),
  );

  return (
    sessions.find((session) => {
      if (session.projectId !== issue.projectId) return false;
      const sessionKeys = [
        session.issueId,
        session.issueUrl,
        session.issueLabel,
        session.metadata["issueId"],
        session.metadata["issueUrl"],
      ]
        .map((value) => normalizeIssueKey(value))
        .filter((value): value is string => Boolean(value));
      return sessionKeys.some((value) => issueKeys.has(value));
    }) ?? null
  );
}

function formatAge(isoDate: string | null | undefined): string {
  if (!isoDate) return "관측 시각 없음";
  const timestamp = new Date(isoDate).getTime();
  if (!Number.isFinite(timestamp)) return "관측 시각 해석 불가";
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return "방금 전";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

function isStale(isoDate: string | null | undefined): boolean {
  if (!isoDate) return true;
  const timestamp = new Date(isoDate).getTime();
  return !Number.isFinite(timestamp) || Date.now() - timestamp > 60 * 60_000;
}

function getLocalVerification(session: DashboardSession | null): {
  label: string;
  detail: string;
  tone: VerificationTone;
} {
  if (!session) {
    return {
      label: "기록 없음",
      detail: "이 이슈와 연결된 세션을 찾지 못해 로컬 검증 기록을 확인할 수 없습니다.",
      tone: "warn",
    };
  }

  const metadata = session.metadata;
  const status =
    metadata["verificationStatus"] ??
    metadata["localVerificationStatus"] ??
    metadata["lastVerificationStatus"];
  const command = metadata["verificationCommand"] ?? metadata["localVerificationCommand"];
  const verifiedAt =
    metadata["verificationAt"] ??
    metadata["verifiedAt"] ??
    metadata["localVerificationAt"] ??
    metadata["lastVerificationAt"];

  if (status === "passed" || status === "verified" || status === "success") {
    return {
      label: "통과",
      detail: `${formatAge(verifiedAt)}${command ? ` · ${command}` : ""}`,
      tone: isStale(verifiedAt) ? "warn" : "ok",
    };
  }
  if (status === "failed" || status === "failure" || status === "error") {
    return {
      label: "실패",
      detail: `${formatAge(verifiedAt)}${command ? ` · ${command}` : ""}`,
      tone: "error",
    };
  }

  return {
    label: "기록 없음",
    detail: "로컬 검증 명령 실행 결과가 세션 메타데이터에 없습니다.",
    tone: "warn",
  };
}

function getCIState(session: DashboardSession | null): {
  label: string;
  detail: string;
  tone: VerificationTone;
  failedChecks: DashboardCICheck[];
} {
  if (!session?.pr) {
    return {
      label: "PR 정보 없음",
      detail: "연결된 PR 또는 CI 관측값이 없습니다.",
      tone: "warn",
      failedChecks: [],
    };
  }

  const failedChecks = session.pr.ciChecks.filter((check) => check.status === "failed");
  if (session.pr.ciStatus === CI_STATUS.FAILING) {
    return {
      label: "실패",
      detail:
        failedChecks.length > 0
          ? `${failedChecks.length}개 체크 실패`
          : "CI 실패 상태지만 실패 체크 이름이 없습니다.",
      tone: "error",
      failedChecks,
    };
  }
  if (session.pr.ciStatus === CI_STATUS.PASSING) {
    return {
      label: "통과",
      detail: `${session.pr.ciChecks.length}개 체크 관측됨`,
      tone: session.pr.enriched === false ? "warn" : "ok",
      failedChecks,
    };
  }
  if (session.pr.ciStatus === CI_STATUS.PENDING) {
    return {
      label: "대기",
      detail: "아직 완료되지 않은 CI가 있습니다.",
      tone: "warn",
      failedChecks,
    };
  }

  return {
    label: "비어 있음",
    detail: "CI 상태가 아직 수집되지 않았습니다.",
    tone: "warn",
    failedChecks,
  };
}

function getFreshness(session: DashboardSession | null): {
  label: string;
  detail: string;
  tone: VerificationTone;
} {
  const observedAt = session?.lifecycle?.pr.lastObservedAt ?? session?.lastActivityAt ?? null;
  if (!observedAt) {
    return {
      label: "관측 없음",
      detail: "PR/세션 관측 시각이 없어 최신 여부를 판단할 수 없습니다.",
      tone: "warn",
    };
  }
  if (isStale(observedAt)) {
    return {
      label: "오래됨",
      detail: `마지막 관측: ${formatAge(observedAt)}`,
      tone: "warn",
    };
  }
  return {
    label: "최신",
    detail: `마지막 관측: ${formatAge(observedAt)}`,
    tone: "ok",
  };
}

function buildGaps(issue: VerificationIssue, session: DashboardSession | null): string[] {
  const gaps: string[] = [];
  const local = getLocalVerification(session);
  const ci = getCIState(session);
  const freshness = getFreshness(session);

  if (!session) {
    gaps.push("이슈와 연결된 AO 세션이 없어 PR, CI, 로컬 검증 증거가 비어 있습니다.");
  }
  if (!session?.pr) {
    gaps.push("연결된 PR 정보가 없어 병합 결과와 CI 상태를 확인할 수 없습니다.");
  } else if (session.pr.enriched === false) {
    gaps.push("PR 상세 수집이 아직 완료되지 않아 CI/리뷰 정보가 기본값일 수 있습니다.");
  }
  if (ci.failedChecks.length > 0) {
    gaps.push(`실패한 CI 체크: ${ci.failedChecks.map((check) => check.name).join(", ")}`);
  } else if (ci.tone === "warn") {
    gaps.push(ci.detail);
  }
  if (local.tone !== "ok") {
    gaps.push(local.detail);
  }
  if (freshness.tone !== "ok") {
    gaps.push(freshness.detail);
  }
  if (!issue.labels.includes("merged-unverified")) {
    gaps.push("이슈에 merged-unverified 라벨이 없어 검증 대기 상태인지 확인이 필요합니다.");
  }

  return gaps.length > 0 ? gaps : ["필수 검증 증거가 모두 수집되었습니다."];
}

function buildEvidence(issue: VerificationIssue, session: DashboardSession | null): string[] {
  const evidence = [
    `이슈 라벨: ${issue.labels.length > 0 ? issue.labels.join(", ") : "없음"}`,
    session?.pr ? `PR #${session.pr.number}: ${session.pr.title}` : "PR 증거 없음",
    session?.lifecycle?.evidence ? `라이프사이클 증거: ${session.lifecycle.evidence}` : null,
    session?.pr?.ciChecks.length
      ? `CI 체크: ${session.pr.ciChecks.map((check) => `${check.name}=${check.status}`).join(", ")}`
      : "CI 체크 증거 없음",
  ];
  return evidence.filter((item): item is string => Boolean(item));
}

function buildCommands(issue: VerificationIssue, session: DashboardSession | null): string[] {
  const issueRef = issue.id;
  const branch = session?.branch;
  return [
    branch ? `git checkout ${branch}` : "연결된 세션/브랜치를 먼저 확인하세요.",
    "pnpm typecheck",
    "pnpm test",
    "pnpm build",
    `ao verify ${issueRef} --project ${issue.projectId}`,
    `ao verify ${issueRef} --project ${issue.projectId} --fail`,
  ];
}

function StatusPill({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: VerificationTone;
}) {
  return (
    <div
      className="border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2"
      data-tone={tone}
    >
      <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-1 text-[12px] font-semibold text-[var(--color-text-primary)]">{value}</div>
      <div className="mt-1 text-[10.5px] leading-4 text-[var(--color-text-muted)]">{detail}</div>
    </div>
  );
}

export function VerificationTab({
  projectId,
  projects = [],
  sessions = [],
  active,
}: VerificationTabProps) {
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
          검증 대기 중인 이슈가 없습니다. `merged-unverified` 라벨이 붙은 열린 이슈가 없거나,
          트래커 연결이 비어 있어 검증 대상 목록을 만들 수 없습니다.
        </div>
      ) : null}

      {scopedIssues.length > 0 ? (
        <div className="space-y-3">
          {scopedIssues.map((issue) => {
            const updating = updatingIssueId === issue.id;
            const session = findIssueSession(issue, sessions);
            const local = getLocalVerification(session);
            const ci = getCIState(session);
            const freshness = getFreshness(session);
            const gaps = buildGaps(issue, session);
            const evidence = buildEvidence(issue, session);
            const commands = buildCommands(issue, session);

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

                <div className="mt-4 grid gap-2 md:grid-cols-3">
                  <StatusPill
                    label="로컬 검증"
                    value={local.label}
                    detail={local.detail}
                    tone={local.tone}
                  />
                  <StatusPill label="CI" value={ci.label} detail={ci.detail} tone={ci.tone} />
                  <StatusPill
                    label="Freshness"
                    value={freshness.label}
                    detail={freshness.detail}
                    tone={freshness.tone}
                  />
                </div>

                <div className="mt-4 grid gap-3 lg:grid-cols-3">
                  <section>
                    <h3 className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
                      실패/경고
                    </h3>
                    <ul className="mt-2 space-y-1.5 text-[11px] leading-4 text-[var(--color-text-muted)]">
                      {gaps.map((gap) => (
                        <li key={gap}>{gap}</li>
                      ))}
                    </ul>
                  </section>

                  <section>
                    <h3 className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
                      증거
                    </h3>
                    <ul className="mt-2 space-y-1.5 text-[11px] leading-4 text-[var(--color-text-muted)]">
                      {evidence.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </section>

                  <section>
                    <h3 className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
                      다음 실행 명령
                    </h3>
                    <div className="mt-2 space-y-1">
                      {commands.map((command) => (
                        <code
                          key={command}
                          className="block border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-2 py-1 text-[10.5px] text-[var(--color-text-secondary)]"
                        >
                          {command}
                        </code>
                      ))}
                    </div>
                  </section>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
