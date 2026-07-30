import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import type { CloudProject, CloudSession } from "@/lib/cloud-api";
import { SessionBoard } from "./page";

const project: CloudProject = {
  id: "project-one",
  displayName: "AO",
  repositoryUrl: "https://github.com/aoagents/agent-orchestrator",
  defaultBranch: "main",
  config: {},
};

const orchestrator: CloudSession = {
  id: "orchestrator-one",
  projectId: project.id,
  kind: "orchestrator",
  harness: "claude-code",
  displayName: "Orchestrator",
  branch: "main",
  activityState: "idle",
  status: "idle",
  runtimeConnected: false,
  isTerminated: false,
  createdAt: "2026-07-30T00:00:00Z",
};

function renderBoard(activeOrchestrator?: CloudSession) {
  render(
    <SessionBoard
      sessions={[]}
      projects={[project]}
      activeSessionIds={new Set()}
      orchestrator={activeOrchestrator}
      onSelect={vi.fn()}
      onCreateOrchestrator={activeOrchestrator ? undefined : vi.fn()}
      agentAvailable
      loading={false}
      onOpenSettings={vi.fn()}
    />,
  );
}

it("shows the Kanban board when the project already has an orchestrator", () => {
  renderBoard(orchestrator);

  expect(screen.getByRole("region", { name: "Working sessions" })).toBeVisible();
  expect(
    screen.getByRole("status", {
      name: "Preparing repository on the cloud VM",
    }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Start orchestrator" }),
  ).not.toBeInTheDocument();
});

it("offers to start the orchestrator only when the project has none", () => {
  renderBoard();

  expect(
    screen.getByRole("button", { name: "Start orchestrator" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("region", { name: "Working sessions" }),
  ).not.toBeInTheDocument();
});
