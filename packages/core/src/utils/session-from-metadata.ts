import type {
  ActivitySignal,
  PRInfo,
  RuntimeHandle,
  Session,
  SessionId,
  SessionKind,
  SessionStatus,
} from "../types.js";
import { deriveLegacyStatus, parseCanonicalLifecycle } from "../lifecycle-state.js";
import { createActivitySignal } from "../activity-signal.js";
import { AGENT_REPORT_METADATA_KEYS } from "../agent-report.js";
import { dedupePrInfos, parsePrFromUrl } from "./pr.js";
import { safeJsonParse, validateStatus } from "./validation.js";

interface SessionFromMetadataOptions {
  projectId?: string;
  workspacePathFallback?: string;
  status?: SessionStatus;
  sessionKind?: SessionKind;
  activity?: Session["activity"];
  activitySignal?: ActivitySignal;
  runtimeHandle?: RuntimeHandle | null;
  createdAt?: Date;
  lastActivityAt?: Date;
  restoredAt?: Date;
}

function deriveDefaultActivitySignal(options: SessionFromMetadataOptions): ActivitySignal {
  if (options.activitySignal) {
    return options.activitySignal;
  }

  if (options.activity === undefined || options.activity === null) {
    return createActivitySignal("unavailable");
  }

  return createActivitySignal("valid", {
    activity: options.activity,
    timestamp: options.lastActivityAt,
    source: options.activity === "exited" ? "runtime" : "native",
  });
}

export function sessionFromMetadata(
  sessionId: SessionId,
  meta: Record<string, string>,
  options: SessionFromMetadataOptions = {},
): Session {
  const runtimeHandle =
    options.runtimeHandle !== undefined
      ? options.runtimeHandle
      : meta["runtimeHandle"]
        ? safeJsonParse<RuntimeHandle>(meta["runtimeHandle"])
        : null;
  const lifecycle = parseCanonicalLifecycle(meta, {
    sessionId,
    status: options.status ?? validateStatus(meta["status"]),
    runtimeHandle,
    createdAt: options.createdAt,
    sessionKind: options.sessionKind,
  });
  const status = options.status ?? deriveLegacyStatus(lifecycle);
  const prUrl = lifecycle.pr.url ?? meta["pr"];
  const prIsDraft = meta[AGENT_REPORT_METADATA_KEYS.PR_IS_DRAFT] === "true";

  // Build a PRInfo object from a single URL string.
  // isDraft defaults to false for secondary PRs — only the primary PR carries the flag.
  const buildPRInfo = (url: string, isDraft = false, lifecyclePrNumber?: number | null): PRInfo => {
    const parsed = parsePrFromUrl(url);
    return {
      number: parsed?.number || lifecyclePrNumber || 0,
      url,
      title: "",
      owner: parsed?.owner ?? "",
      repo: parsed?.repo ?? "",
      branch: meta["branch"] ?? "",
      baseBranch: "",
      isDraft,
    };
  };

  // Build prs[] from metadata.
  // New sessions write "prs" as comma-separated URLs for all PRs.
  // Old sessions only have a single "pr" field — wrap it for backwards compat.
  const prsRaw = meta["prs"];
  const lifecyclePrNumber = lifecycle.pr.number ?? null;
  const parsedPrs: PRInfo[] = prsRaw
    ? prsRaw
        .split(",")
        .map((u, i) =>
          buildPRInfo(u.trim(), i === 0 ? prIsDraft : false, i === 0 ? lifecyclePrNumber : null),
        )
        .filter((p) => Boolean(p.url))
    : prUrl
      ? [buildPRInfo(prUrl, prIsDraft, lifecyclePrNumber)]
      : [];
  const prs = dedupePrInfos(parsedPrs);

  return {
    id: sessionId,
    projectId: meta["project"] ?? options.projectId ?? "",
    status,
    activity: options.activity ?? null,
    activitySignal: deriveDefaultActivitySignal(options),
    lifecycle,
    branch: meta["branch"] || null,
    issueId: meta["issue"] || null,
    pr: prs[0] ?? null,
    prs,
    workspacePath: meta["worktree"] || options.workspacePathFallback || null,
    runtimeHandle: lifecycle.runtime.handle ?? runtimeHandle,
    agentInfo: meta["summary"] ? { summary: meta["summary"], agentSessionId: null } : null,
    createdAt: meta["createdAt"] ? new Date(meta["createdAt"]) : (options.createdAt ?? new Date()),
    lastActivityAt: options.lastActivityAt ?? new Date(),
    restoredAt:
      options.restoredAt ?? (meta["restoredAt"] ? new Date(meta["restoredAt"]) : undefined),
    metadata: meta,
  };
}
