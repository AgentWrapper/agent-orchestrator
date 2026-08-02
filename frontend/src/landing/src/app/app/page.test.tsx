import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import type { CloudProject, CloudSession } from "@/lib/cloud-api";
import CloudAppPage, { SessionBoard } from "./page";

const apiMocks = vi.hoisted(() => ({
  me: vi.fn(),
  projects: vi.fn(),
  sessions: vi.fn(),
  sessionSCM: vi.fn(),
  repositories: vi.fn(),
  providerConnections: vi.fn(),
  invitations: vi.fn(),
  orgInvitations: vi.fn(),
  orgMembers: vi.fn(),
  createOrganization: vi.fn(),
  updateOrganization: vi.fn(),
  updateOrgMemberRole: vi.fn(),
  updateProfile: vi.fn(),
  inviteToOrg: vi.fn(),
  revokeInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
  declineInvitation: vi.fn(),
}));

vi.mock("@/lib/cloud-api", () => ({
  CloudAPI: class {
    me = apiMocks.me;
    projects = apiMocks.projects;
    sessions = apiMocks.sessions;
    sessionSCM = apiMocks.sessionSCM;
    repositories = apiMocks.repositories;
    providerConnections = apiMocks.providerConnections;
    invitations = apiMocks.invitations;
    orgInvitations = apiMocks.orgInvitations;
    orgMembers = apiMocks.orgMembers;
    createOrganization = apiMocks.createOrganization;
    updateOrganization = apiMocks.updateOrganization;
    updateOrgMemberRole = apiMocks.updateOrgMemberRole;
    updateProfile = apiMocks.updateProfile;
    inviteToOrg = apiMocks.inviteToOrg;
    revokeInvitation = apiMocks.revokeInvitation;
    acceptInvitation = apiMocks.acceptInvitation;
    declineInvitation = apiMocks.declineInvitation;
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

const ownerOrg = {
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
} as const;

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  apiMocks.me.mockResolvedValue({
    user: {
      id: "user-one",
      email: "user@example.com",
      displayName: "User",
    },
    sandboxProvider: "daytona",
    organizations: [ownerOrg],
  });
  apiMocks.projects.mockResolvedValue({ projects: [project] });
  apiMocks.sessions.mockResolvedValue({ sessions: [] });
  apiMocks.sessionSCM.mockResolvedValue({ scm: null });
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
  apiMocks.orgMembers.mockResolvedValue({
    members: [
      {
        user: {
          id: "user-one",
          email: "user@example.com",
          displayName: "User",
        },
        membership: ownerOrg.membership,
      },
    ],
  });
  apiMocks.repositories.mockRejectedValue(new Error("GitHub unavailable"));
});

function renderBoard(
  activeOrchestrator?: CloudSession,
  boardSessions: CloudSession[] = [],
  scmBySessionId = {},
) {
  render(
    <SessionBoard
      sessions={boardSessions}
      projects={[project]}
      scmBySessionId={scmBySessionId}
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

it("shows local-style branch, status, and PR details on board cards", () => {
  const worker: CloudSession = {
    ...orchestrator,
    id: "worker-one",
    kind: "worker",
    displayName: "Readme worker",
    branch: "ao/readme-worker",
    status: "review_pending",
    runtimeConnected: true,
  };

  renderBoard(orchestrator, [worker], {
    [worker.id]: {
      pullRequest: {
        repository: "aoagents/agent-orchestrator",
        number: 42,
        url: "https://github.com/aoagents/agent-orchestrator/pull/42",
        title: "Update README",
        state: "open",
        draft: false,
        sourceBranch: "ao/readme-worker",
        targetBranch: "main",
        ciState: "success",
        reviewState: "pending",
        mergeability: "mergeable",
        observedAt: "2026-07-30T00:00:00Z",
      },
      reviewThreads: [
        {
          id: "thread-one",
          isResolved: false,
          isOutdated: false,
          path: "README.md",
          line: 12,
          body: "Please clarify this.",
          authorLogin: "reviewer",
          observedAt: "2026-07-30T00:00:00Z",
        },
      ],
    },
  });

  expect(screen.getByText("Readme worker")).toBeVisible();
  expect(screen.getByText("ao/readme-worker")).toBeVisible();
  expect(screen.getByText(/#42 Update README/)).toBeVisible();
  expect(screen.getByText("1 unresolved review thread")).toBeVisible();
});

it("loads GitHub repositories only when the project form opens", async () => {
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

it("shows invitation status, inviter, and settings notification badge", async () => {
  apiMocks.invitations.mockResolvedValue({
    invitations: [
      {
        id: "invite-in",
        orgId: "org-two",
        email: "user@example.com",
        invitedByEmail: "owner@example.com",
        role: "member",
        status: "pending",
      },
    ],
  });
  apiMocks.orgInvitations.mockResolvedValue({
    invitations: [
      {
        id: "invite-out",
        orgId: "org-one",
        email: "teammate@example.com",
        invitedByEmail: "user@example.com",
        role: "viewer",
        status: "pending",
      },
    ],
  });

  render(<CloudAppPage />);

  const settings = await screen.findByRole("button", { name: /Settings/ });
  expect(
    await screen.findByLabelText("2 settings notifications"),
  ).toBeVisible();
  fireEvent.click(settings);

  expect(await screen.findByText("Organization settings")).toBeVisible();
  expect(screen.getByText("teammate@example.com")).toBeVisible();
  expect(screen.getByText("pending")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
  expect(await screen.findByText("Invited by owner@example.com")).toBeVisible();
});

it("creates a new organization from settings", async () => {
  const teamOrg = {
    organization: {
      id: "org-two",
      slug: "team-alpha",
      displayName: "Team Alpha",
      kind: "team",
      plan: "free",
      status: "active",
    },
    membership: {
      id: "membership-two",
      orgId: "org-two",
      userId: "user-one",
      role: "owner",
      status: "active",
    },
  };
  apiMocks.createOrganization.mockResolvedValue({ organization: teamOrg });

  render(<CloudAppPage />);

  fireEvent.click(await screen.findByRole("button", { name: /Settings/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Add organization" }));
  fireEvent.change(await screen.findByPlaceholderText("New workspace name"), {
    target: { value: "Team Alpha" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  await waitFor(() =>
    expect(apiMocks.createOrganization).toHaveBeenCalledWith({
      displayName: "Team Alpha",
    }),
  );
});

it("updates editable team organization names", async () => {
  apiMocks.me.mockResolvedValue({
    sandboxProvider: "daytona",
    organizations: [
      {
        ...ownerOrg,
        organization: {
          ...ownerOrg.organization,
          kind: "team",
          displayName: "Team One",
        },
      },
    ],
  });
  apiMocks.updateOrganization.mockResolvedValue({
    organization: {
      ...ownerOrg.organization,
      kind: "team",
      displayName: "Team Renamed",
    },
  });

  render(<CloudAppPage />);

  fireEvent.click(await screen.findByRole("button", { name: /Settings/ }));
  const nameInput = await screen.findByDisplayValue("Team One");
  fireEvent.change(nameInput, { target: { value: "Team Renamed" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(apiMocks.updateOrganization).toHaveBeenCalledWith("org-one", {
      displayName: "Team Renamed",
    }),
  );
});

it("lets org admins change another member's role", async () => {
  apiMocks.orgMembers.mockResolvedValue({
    members: [
      {
        user: {
          id: "user-one",
          email: "user@example.com",
          displayName: "User",
        },
        membership: ownerOrg.membership,
      },
      {
        user: {
          id: "user-two",
          email: "viewer@example.com",
          displayName: "Viewer",
        },
        membership: {
          id: "membership-two",
          orgId: "org-one",
          userId: "user-two",
          role: "viewer",
          status: "active",
        },
      },
    ],
  });
  apiMocks.updateOrgMemberRole.mockResolvedValue({
    member: {
      user: {
        id: "user-two",
        email: "viewer@example.com",
        displayName: "Viewer",
      },
      membership: {
        id: "membership-two",
        orgId: "org-one",
        userId: "user-two",
        role: "member",
        status: "active",
      },
    },
  });

  render(<CloudAppPage />);

  fireEvent.click(await screen.findByRole("button", { name: /Settings/ }));
  fireEvent.change(await screen.findByLabelText("Role for viewer@example.com"), {
    target: { value: "member" },
  });

  await waitFor(() =>
    expect(apiMocks.updateOrgMemberRole).toHaveBeenCalledWith(
      "org-one",
      "user-two",
      { role: "member" },
    ),
  );
});

it("updates the current user's profile name from settings", async () => {
  apiMocks.updateProfile.mockResolvedValue({
    user: {
      id: "user-one",
      email: "user@example.com",
      displayName: "Nihal",
    },
  });

  render(<CloudAppPage />);

  fireEvent.click(await screen.findByRole("button", { name: /Settings/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Profile" }));
  const nameInput = await screen.findByDisplayValue("User");
  fireEvent.change(nameInput, { target: { value: "Nihal" } });
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

  await waitFor(() =>
    expect(apiMocks.updateProfile).toHaveBeenCalledWith({
      displayName: "Nihal",
    }),
  );
});
