import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import type { CloudProject, CloudSession } from "@/lib/cloud-api";
import CloudAppPage, { SessionBoard } from "./page";

const apiMocks = vi.hoisted(() => ({
  me: vi.fn(),
  projects: vi.fn(),
  sessions: vi.fn(),
  repositories: vi.fn(),
  providerConnections: vi.fn(),
  invitations: vi.fn(),
  orgInvitations: vi.fn(),
}));

vi.mock("@/lib/cloud-api", () => ({
  CloudAPI: class {
    me = apiMocks.me;
    projects = apiMocks.projects;
    sessions = apiMocks.sessions;
    repositories = apiMocks.repositories;
    providerConnections = apiMocks.providerConnections;
    invitations = apiMocks.invitations;
    orgInvitations = apiMocks.orgInvitations;
  },
}));

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    session: {
      accessToken: "test-token",
      user: {
        id: "user-one",
        email: "user@example.com",
        displayName: "User",
      },
    },
    status: "authenticated",
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock("../auth/PrismLogoGrid", () => ({
  PrismLogoGrid: () => <div aria-label="Loading cloud application" />,
}));

const project: CloudProject = {
  id: "project-one",
  orgId: "org-one",
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

it("loads GitHub repositories only when the project form opens", async () => {
  window.localStorage.clear();
  apiMocks.me.mockResolvedValue({
    sandboxProvider: "daytona",
    organizations: [
      {
        organization: {
          id: "org-one",
          slug: "personal",
          displayName: "Personal",
          kind: "personal",
          plan: "free",
          status: "active",
        },
        membership: {
          id: "membership-one",
          orgId: "org-one",
          userId: "user-one",
          role: "owner",
          status: "active",
        },
      },
    ],
  });
  apiMocks.projects.mockResolvedValue({ projects: [project] });
  apiMocks.sessions.mockResolvedValue({ sessions: [] });
  apiMocks.providerConnections.mockResolvedValue({
    providerConnections: [
      {
        id: "agent-one",
        provider: "claude-code",
        label: "Claude Code",
        config: { credentialType: "oauth_token" },
        validationState: "valid",
      },
    ],
  });
  apiMocks.invitations.mockResolvedValue({ invitations: [] });
  apiMocks.orgInvitations.mockResolvedValue({ invitations: [] });
  apiMocks.repositories.mockRejectedValue(new Error("GitHub unavailable"));

  render(<CloudAppPage />);

  const addProject = await screen.findByRole("button", {
    name: "Add cloud project",
  });
  expect(apiMocks.repositories).not.toHaveBeenCalled();

  fireEvent.click(addProject);

  expect(await screen.findByText("GitHub unavailable")).toBeVisible();
  expect(apiMocks.repositories).toHaveBeenCalledTimes(1);
  expect(screen.getByText(project.displayName)).toBeVisible();
});
