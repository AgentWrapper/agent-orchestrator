import { writeCanonicalArtifact, readCanonicalArtifactIfExists } from "./artifact-store.js";
import {
  readAgentReportAuditTrailAsync,
  type AgentReport,
  type AgentReportAuditEntry,
} from "./agent-report.js";
import { getProjectSessionsDir } from "./paths.js";
import type { Artifact } from "./artifact-schema.js";

const ARTIFACT_ID = "core-agent-status";

/** How many history entries to render in the artifact body. */
const HISTORY_MAX_ENTRIES = 20;

/**
 * Write or update the "agent status" artifact for a session.
 *
 * Called from `ao acknowledge` and `ao report` AFTER the audit-trail entry
 * has been persisted. Reads the session's audit trail and renders the latest
 * state plus full reporting history as a single markdown card.
 *
 * Best-effort — `ao report` is on the agent's critical path and must never
 * fail because of an auto-artifact issue. Any error is logged and swallowed.
 */
export async function writeAgentStatusArtifact(
  projectId: string,
  sessionId: string,
  latestReport: AgentReport,
): Promise<void> {
  try {
    if (
      !projectId ||
      !sessionId ||
      !latestReport ||
      typeof latestReport.state !== "string"
    ) {
      return;
    }

    // Read the audit trail so we can render full history. If reading fails
    // (corrupt file, perms issue), fall back to rendering just the latest.
    let trail: AgentReportAuditEntry[] = [];
    try {
      const sessionsDir = getProjectSessionsDir(projectId);
      trail = await readAgentReportAuditTrailAsync(sessionsDir, sessionId);
    } catch {
      // best-effort
    }

    let previous: Artifact | null = null;
    try {
      previous = await readCanonicalArtifactIfExists(projectId, sessionId, ARTIFACT_ID);
    } catch {
      // best-effort
    }

    const now = new Date().toISOString();
    const markdown = buildBody(latestReport, trail);

    const artifact: Artifact = {
      version: 1,
      id: ARTIFACT_ID,
      type: "markdown",
      title: "Agent status",
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      source: "synth-core",
      payload: { markdown },
    };

    await writeCanonicalArtifact(projectId, sessionId, artifact);
  } catch (err) {
    console.warn(
      `[agent-status-artifact] write failed for ${sessionId ?? "?"}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function buildBody(latest: AgentReport, trail: AgentReportAuditEntry[]): string {
  const lines: string[] = [];

  // Header: latest state + when + source
  lines.push(`**Current state:** \`${latest.state}\``);
  lines.push("");
  lines.push(
    `_Last reported via ${latest.source === "acknowledge" ? "`ao acknowledge`" : "`ao report`"} at ${formatTime(latest.timestamp)}_`,
  );

  // PR info from the latest report (if attached)
  if (latest.prUrl || latest.prNumber !== undefined) {
    const parts: string[] = [];
    if (latest.prNumber !== undefined) parts.push(`#${latest.prNumber}`);
    if (latest.prUrl) parts.push(latest.prUrl);
    if (latest.prIsDraft) parts.push("(draft)");
    lines.push("");
    lines.push(`**PR:** ${parts.join(" ")}`);
  }

  // Latest note
  if (latest.note) {
    lines.push("");
    lines.push(`> ${latest.note.replace(/\n/g, "\n> ")}`);
  }

  // History — every report in the trail, newest first, capped at HISTORY_MAX_ENTRIES.
  // Trail is appended chronologically so we reverse to get newest first.
  if (trail.length > 0) {
    const sorted = [...trail].sort((a, b) =>
      a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0,
    );
    const entries = sorted.slice(0, HISTORY_MAX_ENTRIES);

    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(
      `### History (${trail.length} report${trail.length === 1 ? "" : "s"}${trail.length > HISTORY_MAX_ENTRIES ? `, showing latest ${HISTORY_MAX_ENTRIES}` : ""})`,
    );
    lines.push("");
    for (const entry of entries) {
      lines.push(buildHistoryLine(entry));
    }
  }

  return lines.join("\n");
}

function buildHistoryLine(entry: AgentReportAuditEntry): string {
  const time = formatTime(entry.timestamp).slice(11, 19); // HH:MM:SS
  const parts: string[] = [`- **${time}** \`${entry.reportState}\``];

  if (entry.prNumber !== undefined) {
    parts.push(`(#${entry.prNumber}${entry.prIsDraft ? ", draft" : ""})`);
  }

  if (entry.note) {
    // Truncate long notes to keep the list readable
    const oneLine = entry.note.replace(/\n+/g, " ").trim();
    const truncated = oneLine.length > 120 ? oneLine.slice(0, 117) + "…" : oneLine;
    parts.push(`— ${truncated}`);
  }

  return parts.join(" ");
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toISOString().slice(0, 19).replace("T", " ") + " UTC";
}
