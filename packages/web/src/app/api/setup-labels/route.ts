import { NextResponse } from "next/server";
import { recordActivityEvent } from "@aoagents/ao-core";
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
];

/**
 * POST /api/setup-labels — Create agent labels on all configured repos.
 * Idempotent — skips labels that already exist.
 */
export async function POST() {
  try {
    const { config } = await getServices();
    const results: Array<{ repo: string; label: string; status: string }> = [];

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
        } catch {
          results.push({ repo: project.repo, label: label.name, status: "exists" });
        }
      }
    }

    const created = results.filter((r) => r.status === "created").length;
    const exists = results.filter((r) => r.status === "exists").length;
    recordActivityEvent({
      source: "api",
      kind: "api.labels_setup",
      summary: `labels setup complete: ${created} created, ${exists} exists`,
      data: { created, exists, total: results.length },
    });

    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to setup labels" },
      { status: 500 },
    );
  }
}
