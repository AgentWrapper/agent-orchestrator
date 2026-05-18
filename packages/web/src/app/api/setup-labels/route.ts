import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

const LABELS = [
  { name: "agent:backlog", color: "6B7280", description: "Available for agent to claim" },
  { name: "agent:in-progress", color: "7C3AED", description: "Agent is working on this" },
  { name: "agent:blocked", color: "DC2626", description: "Agent is blocked" },
  { name: "agent:done", color: "16A34A", description: "Agent completed this" },
  { name: "merged-unverified", color: "F59E0B", description: "PR merged; awaiting verification" },
  { name: "verified", color: "16A34A", description: "Work verified after staging check" },
  {
    name: "verification-failed",
    color: "DC2626",
    description: "Verification failed; needs follow-up",
  },
];

type SetupLabelResult = {
  repo: string;
  label: string;
  status: "created" | "exists" | "failed";
  error?: string;
};

function commandErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const stderr = "stderr" in error ? (error as { stderr?: unknown }).stderr : undefined;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
    if (error instanceof Error) return error.message;
  }
  return String(error);
}

function isExistingLabelError(error: unknown): boolean {
  return commandErrorMessage(error).toLowerCase().includes("already exists");
}

/**
 * POST /api/setup-labels — Create agent labels on all configured repos.
 * Idempotent — skips labels that already exist.
 */
export async function POST() {
  try {
    const { config } = await getServices();
    const results: SetupLabelResult[] = [];
    let hasFailures = false;

    for (const project of Object.values(config.projects)) {
      if (!project.repo) continue;

      for (const label of LABELS) {
        try {
          await execFileAsync(
            "gh",
            [
              "label",
              "create",
              label.name,
              "--repo",
              project.repo,
              "--color",
              label.color,
              "--description",
              label.description,
              "--force",
            ],
            { timeout: 10_000 },
          );
          results.push({ repo: project.repo, label: label.name, status: "created" });
        } catch (error) {
          if (isExistingLabelError(error)) {
            results.push({ repo: project.repo, label: label.name, status: "exists" });
            continue;
          }
          hasFailures = true;
          results.push({
            repo: project.repo,
            label: label.name,
            status: "failed",
            error: commandErrorMessage(error),
          });
        }
      }
    }

    return NextResponse.json({ results }, { status: hasFailures ? 207 : 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to setup labels" },
      { status: 500 },
    );
  }
}
