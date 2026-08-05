import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import {
  CloudAPIError,
  type CloudProject,
  type CloudSession,
} from "@/lib/cloud-api";
import CloudAppPage, { SessionBoard } from "./page";

const apiMocks = vi.hoisted(() => ({
  refreshAuthSession: vi.fn(),
  me: vi.fn(),
  projects: vi.fn(),
  sessions: vi.fn(),
  session: vi.fn(),
  sessionSCM: vi.fn(),
  workspaceDiff: vi.fn(),
  workspaceFiles: vi.fn(),
  repositories: vi.fn(),
  githubConnection: vi.fn(),
  githubUserConnection: vi.fn(),
  startGitHubUserAuthorization: vi.fn(),
  syncGitHubUserConnection: vi.fn(),
  disconnectGitHubUser: vi.fn(),
  startGitHubInstall: vi.fn(),
  syncGitHub: vi.fn(),
  disconnectGitHubInstallation: vi.fn(),
  createProject: vi.fn(),
  createScratchProject: vi.fn(),
  createSession: vi.fn(),
  providerConnections: vi.fn(),
  updateProviderSettings: vi.fn(),
  createProjectShareLink: vi.fn(),
  redeemProjectShareLink: vi.fn(),
  projectShareAccess: vi.fn(),
  updateProjectShareGrant: vi.fn(),
  revokeProjectShareGrant: vi.fn(),
  revokeProjectShareLink: vi.fn(),
  deleteProject: vi.fn(),
  deleteSession: vi.fn(),
  sharedProjects: vi.fn(),
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
  CloudAPIError: class extends Error {
    code?: string;
    status: number;

    constructor(message: string, status: number, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  CloudAPI: class {
    me = apiMocks.me;
    projects = apiMocks.projects;
    sessions = apiMocks.sessions;
    session = apiMocks.session;
    sessionSCM = apiMocks.sessionSCM;
    workspaceDiff = apiMocks.workspaceDiff;
    workspaceFiles = apiMocks.workspaceFiles;
    repositories = apiMocks.repositories;
    githubConnection = apiMocks.githubConnection;
    githubUserConnection = apiMocks.githubUserConnection;
    startGitHubUserAuthorization = apiMocks.startGitHubUserAuthorization;
    syncGitHubUserConnection = apiMocks.syncGitHubUserConnection;
    disconnectGitHubUser = apiMocks.disconnectGitHubUser;
    startGitHubInstall = apiMocks.startGitHubInstall;
    syncGitHub = apiMocks.syncGitHub;
    disconnectGitHubInstallation = apiMocks.disconnectGitHubInstallation;
    createProject = apiMocks.createProject;
    createScratchProject = apiMocks.createScratchProject;
    createSession = apiMocks.createSession;
    providerConnections = apiMocks.providerConnections;
    updateProviderSettings = apiMocks.updateProviderSettings;
    createProjectShareLink = apiMocks.createProjectShareLink;
    redeemProjectShareLink = apiMocks.redeemProjectShareLink;
    projectShareAccess = apiMocks.projectShareAccess;
    updateProjectShareGrant = apiMocks.updateProjectShareGrant;
    revokeProjectShareGrant = apiMocks.revokeProjectShareGrant;
    revokeProjectShareLink = apiMocks.revokeProjectShareLink;
    deleteProject = apiMocks.deleteProject;
    deleteSession = apiMocks.deleteSession;
    sharedProjects = apiMocks.sharedProjects;
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
    refreshSession: apiMocks.refreshAuthSession,
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

const worker: CloudSession = {
  id: "worker-one",
  projectId: project.id,
  kind: "worker",
  harness: "claude-code",
  displayName: "readme-reader",
  branch: "ao/readme-reader",
  activityState: "idle",
  status: "idle",
  runtimeConnected: true,
  isTerminated: false,
  createdAt: "2026-07-30T00:01:00Z",
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
  window.history.replaceState({}, "", "/app");
  vi.clearAllMocks();
  apiMocks.refreshAuthSession.mockResolvedValue({
    accessToken: "test-token",
    user: {
      id: "user-one",
      email: "user@example.com",
      displayName: "User",
    },
  });
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
  apiMocks.session.mockResolvedValue({ session: worker });
  apiMocks.sessionSCM.mockResolvedValue({ scm: null });
  apiMocks.workspaceDiff.mockResolvedValue({ entries: [], summary: "" });
  apiMocks.workspaceFiles.mockResolvedValue({ entries: [] });
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
  apiMocks.githubConnection.mockResolvedValue({
    mode: "github-app",
    appSlug: "ao-cloud",
    installations: [],
    repositories: [],
  });
  apiMocks.githubUserConnection.mockResolvedValue({
    connected: true,
    login: "aoagents",
    installations: [
      {
        githubInstallationId: 42,
        accountLogin: "aoagents",
        accountType: "Organization",
        repositorySelection: "all",
        canCreateRepository: true,
      },
    ],
  });
  apiMocks.githubUserConnection.mockResolvedValue({
    connected: false,
    installations: [],
  });
  apiMocks.startGitHubUserAuthorization.mockResolvedValue({
    authorizeUrl: "https://github.com/login/oauth/authorize",
  });
  apiMocks.syncGitHubUserConnection.mockResolvedValue({
    connected: false,
    installations: [],
  });
  apiMocks.disconnectGitHubUser.mockResolvedValue(undefined);
  apiMocks.startGitHubInstall.mockResolvedValue({
    installUrl: "https://github.com/apps/ao-cloud/installations/new",
  });
  apiMocks.syncGitHub.mockResolvedValue(undefined);
  apiMocks.disconnectGitHubInstallation.mockResolvedValue(undefined);
  apiMocks.createProject.mockResolvedValue({ project });
  apiMocks.createScratchProject.mockResolvedValue({ project, repository: null });
  apiMocks.createSession.mockResolvedValue({ session: orchestrator, created: true });
  apiMocks.updateProviderSettings.mockResolvedValue(undefined);
  apiMocks.createProjectShareLink.mockResolvedValue({
    token: "share-token",
    shareLink: { id: "link-one" },
  });
  apiMocks.projectShareAccess.mockResolvedValue({
    access: { links: [], grants: [] },
  });
  apiMocks.updateProjectShareGrant.mockResolvedValue({ grant: { id: "grant-one" } });
  apiMocks.revokeProjectShareGrant.mockResolvedValue(undefined);
  apiMocks.revokeProjectShareLink.mockResolvedValue(undefined);
  apiMocks.deleteProject.mockResolvedValue(undefined);
  apiMocks.deleteSession.mockResolvedValue(undefined);
  apiMocks.sharedProjects.mockResolvedValue({ shares: [] });
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

it("loads invitations for an invite-gated user without an organization", async () => {
  apiMocks.me.mockResolvedValue({
    user: {
      id: "user-invited",
      email: "invited@example.com",
      displayName: "Invited User",
    },
    sandboxProvider: "daytona",
    organizations: [],
  });

  render(<CloudAppPage />);

  await waitFor(() => expect(apiMocks.invitations).toHaveBeenCalled());
  expect(apiMocks.projects).not.toHaveBeenCalled();
  expect(apiMocks.sessions).not.toHaveBeenCalled();
});

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

  expect(await screen.findByText("Enable scratch projects")).toBeVisible();
  expect(
    screen.getByText(
      "Authorize AO with your GitHub account to create new repositories.",
    ),
  ).toBeVisible();
  expect(apiMocks.repositories).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", {
      name: "Authorize AO in Settings",
    }),
  ).toBeVisible();
  expect(screen.getByText(project.displayName)).toBeVisible();
});

it("prompts for a coding agent before opening provider settings", async () => {
  apiMocks.providerConnections.mockResolvedValue({ providerConnections: [] });
  render(<CloudAppPage />);

  fireEvent.click(
    await screen.findByRole("button", { name: "Add cloud project" }),
  );

  const prompt = await screen.findByRole("dialog", {
    name: "Connect a coding agent",
  });
  expect(prompt).toBeVisible();
  expect(
    screen.queryByRole("dialog", { name: "Add cloud project" }),
  ).not.toBeInTheDocument();
  expect(apiMocks.repositories).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("heading", { name: "Provider connections" }),
  ).not.toBeInTheDocument();

  fireEvent.click(within(prompt).getByRole("button", { name: "Close" }));

  expect(
    await screen.findByRole("heading", { name: "Provider connections" }),
  ).toBeVisible();
  expect(screen.getByText("Coding agents")).toBeVisible();
});

it("creates a scratch project through the connected GitHub installation", async () => {
  const scratchProject: CloudProject = {
    ...project,
    id: "scratch-project",
    displayName: "Scratch App",
    repositoryUrl: "https://github.com/aoagents/scratch-app",
  };
  apiMocks.repositories.mockResolvedValue({ repositories: [] });
  apiMocks.githubConnection.mockResolvedValue({
    mode: "github-app",
    appSlug: "ao-cloud",
    installations: [
      {
        id: "installation-one",
        githubInstallationId: 42,
        accountLogin: "aoagents",
        accountType: "Organization",
        status: "active",
        repositorySelection: "all",
      },
    ],
    repositories: [],
  });
  apiMocks.githubUserConnection.mockResolvedValue({
    connected: true,
    login: "aoagents",
    installations: [
      {
        githubInstallationId: 42,
        accountLogin: "aoagents",
        accountType: "Organization",
        repositorySelection: "all",
        canCreateRepository: true,
      },
    ],
  });
  apiMocks.createScratchProject.mockResolvedValue({
    project: scratchProject,
    repository: {
      id: 991,
      fullName: "aoagents/scratch-app",
      htmlUrl: "https://github.com/aoagents/scratch-app",
      defaultBranch: "main",
      private: true,
      archived: false,
      disabled: false,
    },
    session: { ...orchestrator, id: "scratch-orchestrator", projectId: "scratch-project" },
  });

  render(<CloudAppPage />);

  fireEvent.click(await screen.findByRole("button", { name: "Add cloud project" }));
  fireEvent.click(await screen.findByRole("button", { name: /Start from scratch/ }));
  expect(
    screen.queryByText(/Owners come from your account-wide GitHub connection/),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Owners configured for selected repositories/),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Connect another" }),
  ).toBeVisible();
  fireEvent.change(screen.getByPlaceholderText("my-new-app"), {
    target: { value: "Scratch App" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create from scratch" }));

  await waitFor(() =>
    expect(apiMocks.createScratchProject).toHaveBeenCalledWith("org-one", {
      displayName: "Scratch App",
      githubInstallationId: 42,
      private: true,
      orchestrator: {
        harness: "claude-code",
        providerConnectionId: undefined,
      },
    }),
  );
  expect(apiMocks.createSession).not.toHaveBeenCalled();
});

it("creates a scratch project in the selected connected organization", async () => {
  apiMocks.repositories.mockResolvedValue({ repositories: [] });
  apiMocks.githubConnection.mockResolvedValue({
    mode: "github-app",
    appSlug: "ao-cloud",
    installations: [
      {
        id: "installation-personal",
        githubInstallationId: 41,
        accountLogin: "amoreX",
        accountType: "User",
        status: "active",
        repositorySelection: "all",
      },
      {
        id: "installation-one",
        githubInstallationId: 42,
        accountLogin: "rae-app",
        accountType: "Organization",
        status: "active",
        repositorySelection: "all",
      },
      {
        id: "installation-two",
        githubInstallationId: 43,
        accountLogin: "unordinarytech",
        accountType: "Organization",
        status: "active",
        repositorySelection: "all",
      },
    ],
    repositories: [],
  });
  apiMocks.githubUserConnection.mockResolvedValue({
    connected: true,
    login: "amoreX",
    installations: [
      {
        githubInstallationId: 41,
        accountLogin: "amoreX",
        accountType: "User",
        repositorySelection: "all",
        canCreateRepository: true,
      },
      {
        githubInstallationId: 42,
        accountLogin: "rae-app",
        accountType: "Organization",
        repositorySelection: "all",
        canCreateRepository: true,
      },
      {
        githubInstallationId: 43,
        accountLogin: "unordinarytech",
        accountType: "Organization",
        repositorySelection: "all",
        canCreateRepository: true,
      },
    ],
  });
  apiMocks.createScratchProject.mockResolvedValue({
    project: {
      ...project,
      id: "scratch-project",
      displayName: "Scratch App",
      repositoryUrl: "https://github.com/unordinarytech/scratch-app",
    },
    repository: {
      id: 991,
      fullName: "unordinarytech/scratch-app",
      htmlUrl: "https://github.com/unordinarytech/scratch-app",
      defaultBranch: "main",
      private: true,
      archived: false,
      disabled: false,
    },
    session: {
      ...orchestrator,
      id: "scratch-orchestrator",
      projectId: "scratch-project",
    },
  });

  render(<CloudAppPage />);

  fireEvent.click(await screen.findByRole("button", { name: "Add cloud project" }));
  fireEvent.click(await screen.findByRole("button", { name: /Start from scratch/ }));

  const ownerSelect = screen.getByRole("combobox", {
    name: "GitHub owner",
  });
  expect(
    within(ownerSelect).getByRole("option", { name: "amoreX · personal" }),
  ).toBeVisible();
  expect(
    within(ownerSelect).getByRole("option", { name: "rae-app · organization" }),
  ).toBeVisible();
  expect(
    within(ownerSelect).getByRole("option", {
      name: "unordinarytech · organization",
    }),
  ).toBeVisible();

  fireEvent.change(ownerSelect, { target: { value: "43" } });
  fireEvent.change(screen.getByPlaceholderText("my-new-app"), {
    target: { value: "Scratch App" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create from scratch" }));

  await waitFor(() =>
    expect(apiMocks.createScratchProject).toHaveBeenCalledWith("org-one", {
      displayName: "Scratch App",
      githubInstallationId: 43,
      private: true,
      orchestrator: {
        harness: "claude-code",
        providerConnectionId: undefined,
      },
    }),
  );
});

it("opens provider connections from the no-agent empty state", async () => {
  apiMocks.providerConnections.mockResolvedValue({ providerConnections: [] });
  render(<CloudAppPage />);

  fireEvent.click(await screen.findByRole("button", { name: "Connect an agent" }));

  expect(
    await screen.findByRole("heading", { name: "Provider connections" }),
  ).toBeVisible();
  expect(screen.getByText("Coding agents")).toBeVisible();
});

it("shares a project from its three-dot menu with the selected role", async () => {
  render(<CloudAppPage />);

  fireEvent.click(
    await screen.findByRole("button", {
      name: `More actions for ${project.displayName}`,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Share project" }));

  expect(
    screen.getByRole("heading", { name: "Share project" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("radio", { name: /Editor/ }));
  fireEvent.click(screen.getByRole("button", { name: /Restricted/ }));
  fireEvent.change(screen.getByLabelText("People"), {
    target: { value: "reader@example.com" },
  });
  fireEvent.click(screen.getByLabelText("Personal"));
  fireEvent.click(screen.getByRole("button", { name: "Create link" }));

  await waitFor(() =>
    expect(apiMocks.createProjectShareLink).toHaveBeenCalledWith(
      "org-one",
      project.id,
      {
        role: "editor",
        accessScope: "restricted",
        recipientEmails: ["reader@example.com"],
        recipientOrgIds: ["org-one"],
      },
    ),
  );
  expect(await screen.findByDisplayValue(/share=share-token/)).toBeVisible();
});

it("manages redeemed project share access", async () => {
  apiMocks.projectShareAccess.mockResolvedValue({
    access: {
      links: [
        {
          id: "link-one",
          accessScope: "anyone",
          role: "viewer",
          recipients: [],
        },
      ],
      grants: [
        {
          id: "grant-one",
          role: "viewer",
          user: {
            id: "user-two",
            email: "reader@example.com",
            displayName: "Reader",
          },
        },
      ],
    },
  });
  render(<CloudAppPage />);

  fireEvent.click(
    await screen.findByRole("button", {
      name: `More actions for ${project.displayName}`,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Share project" }));

  const accessSelect = await screen.findByLabelText(
    "Access for reader@example.com",
  );
  fireEvent.change(accessSelect, { target: { value: "editor" } });
  await waitFor(() =>
    expect(apiMocks.updateProjectShareGrant).toHaveBeenCalledWith(
      "org-one",
      project.id,
      "grant-one",
      { role: "editor" },
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() =>
    expect(apiMocks.revokeProjectShareGrant).toHaveBeenCalledWith(
      "org-one",
      project.id,
      "grant-one",
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  await waitFor(() =>
    expect(apiMocks.revokeProjectShareLink).toHaveBeenCalledWith(
      "org-one",
      project.id,
      "link-one",
    ),
  );
});

it("shows shared projects with their sessions without switching workspace", async () => {
  const sharedProject: CloudProject = {
    ...project,
    id: "shared-project",
    orgId: "shared-org",
    displayName: "Shared AO",
  };
  const sharedOrchestrator: CloudSession = {
    ...orchestrator,
    id: "shared-orchestrator",
    projectId: sharedProject.id,
    displayName: "Shared Orchestrator",
  };
  apiMocks.sharedProjects.mockResolvedValue({
    shares: [
      {
        id: "share-one",
        orgId: "shared-org",
        project: sharedProject,
        role: "viewer",
        sharedByEmail: "teammate@example.com",
        sharedByName: "Teammate",
        redeemedAt: "2026-08-04T00:00:00Z",
      },
    ],
  });
  apiMocks.sessions.mockImplementation((orgId: string) =>
    Promise.resolve({
      sessions: orgId === "shared-org" ? [sharedOrchestrator] : [],
    }),
  );

  render(<CloudAppPage />);

  const sharedProjectButton = await screen.findByRole("button", {
      name: "Shared AO, shared by Teammate",
    });
  const sharedProjectToggle = screen.getByRole("button", {
    name: "Collapse Shared AO",
  });
  expect(sharedProjectButton).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: sharedOrchestrator.displayName }),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Connecting orchestrator",
  );
  fireEvent.click(sharedProjectButton);
  expect(screen.getByRole("region", { name: "Working sessions" })).toBeVisible();
  expect(sharedProjectToggle).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(sharedProjectToggle);
  expect(sharedProjectToggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(screen.getByText("Personal"));

  expect(
    screen.getByRole("menuitemradio", { name: /Personal.*owner/i }),
  ).toHaveAttribute("aria-checked", "true");
});

it("silently ignores a share link redeemed by its creator", async () => {
  window.history.replaceState({}, "", "/app?share=own-share-token");
  apiMocks.redeemProjectShareLink.mockRejectedValue(
    new CloudAPIError(
      "You already own this shared project.",
      400,
      "SHARE_SELF_REDEEM",
    ),
  );

  render(<CloudAppPage />);

  await waitFor(() =>
    expect(apiMocks.redeemProjectShareLink).toHaveBeenCalledWith(
      "own-share-token",
    ),
  );
  expect(window.location.search).toBe("");
  expect(
    screen.queryByText("You already own this shared project."),
  ).not.toBeInTheDocument();
});

it("shows simplified GitHub organization access controls", async () => {
  apiMocks.githubConnection.mockResolvedValue({
    mode: "github-app",
    appSlug: "ao-cloud",
    installations: [
      {
        id: "installation-one",
        githubInstallationId: 42,
        accountLogin: "aoagents",
        accountType: "Organization",
        status: "active",
        repositorySelection: "selected",
      },
    ],
    repositories: [
      {
        repository: {
          id: 7,
          fullName: "aoagents/agent-orchestrator",
          htmlUrl: "https://github.com/aoagents/agent-orchestrator",
          defaultBranch: "main",
          private: true,
          archived: false,
          disabled: false,
        },
        grant: {
          installationId: "installation-one",
          githubInstallationId: 42,
          repositorySelection: "selected",
          grantedAt: "2026-08-03T00:00:00Z",
          lastSyncedAt: "2026-08-03T00:00:00Z",
        },
      },
    ],
  });
  const confirmDisconnect = vi.spyOn(window, "confirm").mockReturnValue(true);

  render(<CloudAppPage />);

  fireEvent.click(await screen.findByRole("button", { name: /Settings/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Provider connections" }),
  );

  const organizationAccess = await screen.findByRole("button", {
    name: "Organization repository access",
  });
  const gitHubSection = within(organizationAccess.closest("section")!);
  const organizationAccessHeader = within(organizationAccess.parentElement!);
  const manageAccess = organizationAccessHeader.getByRole("button", {
    name: "Manage organization repository access",
  });
  expect(manageAccess).toBeVisible();
  expect(gitHubSection.queryByText(/granted repositor/)).not.toBeInTheDocument();
  expect(
    gitHubSection.queryByText("aoagents/agent-orchestrator"),
  ).not.toBeInTheDocument();
  fireEvent.click(organizationAccess);
  expect(gitHubSection.getByText("aoagents")).toBeVisible();
  expect(gitHubSection.getByText("Organization · selected repositories")).toBeVisible();
  expect(gitHubSection.queryByRole("link", { name: /Configure/ })).not.toBeInTheDocument();
  expect(gitHubSection.queryByRole("button", { name: /Sync/ })).not.toBeInTheDocument();
  expect(gitHubSection.queryByRole("link", { name: /Manage/ })).not.toBeInTheDocument();

  fireEvent.click(manageAccess);
  await waitFor(() =>
    expect(apiMocks.startGitHubInstall).toHaveBeenCalledWith("org-one"),
  );

  fireEvent.click(gitHubSection.getByRole("button", { name: "Disconnect" }));
  expect(confirmDisconnect).toHaveBeenCalledWith(
    expect.stringContaining("Disconnect GitHub account aoagents?"),
  );
  await waitFor(() =>
    expect(apiMocks.disconnectGitHubInstallation).toHaveBeenCalledWith(
      "org-one",
      42,
    ),
  );
});

it("shows local GitHub authentication as locally managed without app controls", async () => {
  apiMocks.githubConnection.mockResolvedValue({
    mode: "local-gh",
    appSlug: "",
    installations: [],
    repositories: [],
  });

  render(<CloudAppPage />);

  fireEvent.click(await screen.findByRole("button", { name: /Settings/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Provider connections" }),
  );

  const localHeading = await screen.findByText("Host GitHub CLI");
  const gitHubSection = within(localHeading.closest("section")!);
  expect(localHeading).toBeVisible();
  expect(gitHubSection.getByText("Managed locally")).toBeVisible();
  expect(
    gitHubSection.queryByRole("button", { name: /Connect GitHub/ }),
  ).not.toBeInTheDocument();
  expect(
    gitHubSection.queryByRole("button", { name: "Disconnect" }),
  ).not.toBeInTheDocument();
});

it("lets members manage their account-wide GitHub identity", async () => {
  apiMocks.me.mockResolvedValue({
    user: {
      id: "user-one",
      email: "user@example.com",
      displayName: "User",
    },
    sandboxProvider: "daytona",
    organizations: [
      {
        ...ownerOrg,
        membership: { ...ownerOrg.membership, role: "member" },
      },
    ],
  });
  apiMocks.githubConnection.mockResolvedValue({
    mode: "github-app",
    appSlug: "ao-cloud",
    installations: [
      {
        id: "installation-one",
        githubInstallationId: 42,
        accountLogin: "aoagents",
        accountType: "Organization",
        status: "active",
        repositorySelection: "all",
      },
    ],
    repositories: [],
  });
  apiMocks.githubUserConnection.mockResolvedValue({
    connected: true,
    login: "aoagents",
    installations: [
      {
        githubInstallationId: 42,
        accountLogin: "aoagents",
        accountType: "Organization",
        repositorySelection: "all",
        canCreateRepository: true,
      },
    ],
  });

  render(<CloudAppPage />);

  fireEvent.click(await screen.findByRole("button", { name: /Settings/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Provider connections" }),
  );

  expect((await screen.findAllByText("aoagents")).length).toBeGreaterThan(0);
  expect(
    screen.getByRole("button", { name: "Repository creation access" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Organization repository access" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Install on another account" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Scratch ready")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Manage/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeVisible();
});

it("guides a fully disconnected user through account authorization first", async () => {
  render(<CloudAppPage />);

  fireEvent.click(await screen.findByRole("button", { name: /Settings/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Provider connections" }),
  );

  expect(
    await screen.findByRole("button", { name: "Connect GitHub" }),
  ).toBeVisible();
  expect(
    screen.getByText(
      "AO will connect your GitHub account and organization repository access in two steps.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Repository creation access" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Organization repository access" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/granted repositor/)).not.toBeInTheDocument();
});

it("prompts for organization access when the GitHub account is connected", async () => {
  apiMocks.githubUserConnection.mockResolvedValue({
    connected: true,
    login: "aoagents",
    installations: [],
  });

  render(<CloudAppPage />);

  fireEvent.click(await screen.findByRole("button", { name: /Settings/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Provider connections" }),
  );

  expect(
    await screen.findByRole("button", { name: "Connect organization" }),
  ).toBeVisible();
});

it("prompts for account authorization when organization access is connected", async () => {
  apiMocks.githubConnection.mockResolvedValue({
    mode: "github-app",
    appSlug: "ao-cloud",
    installations: [
      {
        id: "installation-one",
        githubInstallationId: 42,
        accountLogin: "aoagents",
        accountType: "Organization",
        status: "active",
        repositorySelection: "all",
      },
    ],
    repositories: [],
  });

  render(<CloudAppPage />);

  fireEvent.click(await screen.findByRole("button", { name: /Settings/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Provider connections" }),
  );

  expect(
    await screen.findByRole("button", { name: "Connect account" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Connect organization" }),
  ).not.toBeInTheDocument();
});

it("continues from GitHub account authorization to organization access", async () => {
  apiMocks.githubUserConnection.mockResolvedValue({
    connected: true,
    login: "aoagents",
    installations: [],
  });
  window.history.replaceState(
    {},
    "",
    "/app?settings=github&github=connected",
  );

  render(<CloudAppPage />);

  await waitFor(() =>
    expect(apiMocks.startGitHubInstall).toHaveBeenCalledWith("org-one"),
  );
  expect(apiMocks.startGitHubInstall).toHaveBeenCalledTimes(1);
});

it("opens provider settings when returning from the GitHub callback", async () => {
  window.history.replaceState(
    {},
    "",
    "/app?settings=github&github=account_already_connected",
  );

  render(<CloudAppPage />);

  expect(await screen.findByText("GitHub account not connected")).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This GitHub account is already connected to another AO user.",
  );
  expect(screen.getByText("Coding agents")).toBeVisible();
  expect(window.location.search).toBe("");
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
      {
        id: "invite-decline",
        orgId: "org-three",
        email: "other@example.com",
        invitedByEmail: "admin@example.com",
        role: "viewer",
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
    await screen.findByLabelText("3 settings notifications"),
  ).toBeVisible();
  fireEvent.click(settings);

  expect(await screen.findByText("Organization settings")).toBeVisible();
  expect(screen.getByText("teammate@example.com")).toBeVisible();
  expect(screen.getByText("pending")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  await waitFor(() =>
    expect(apiMocks.revokeInvitation).toHaveBeenCalledWith(
      "org-one",
      "invite-out",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
  expect(await screen.findByText("Invited by owner@example.com")).toBeVisible();
  const incomingInvite = screen.getByText("user@example.com as member")
    .parentElement?.parentElement;
  if (!incomingInvite) {
    throw new Error("incoming invitation card not found");
  }
  fireEvent.click(within(incomingInvite).getByRole("button", { name: "Accept" }));
  await waitFor(() =>
    expect(apiMocks.acceptInvitation).toHaveBeenCalledWith("invite-in"),
  );
  const declinedInvite = screen.getByText("other@example.com as viewer")
    .parentElement?.parentElement;
  if (!declinedInvite) {
    throw new Error("declined invitation card not found");
  }
  fireEvent.click(
    within(declinedInvite).getByRole("button", { name: "Decline" }),
  );
  await waitFor(() =>
    expect(apiMocks.declineInvitation).toHaveBeenCalledWith("invite-decline"),
  );
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

it("shows and updates the organization credential source in org settings", async () => {
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
  apiMocks.providerConnections.mockResolvedValue({
    providerConnections: [],
    agentCredentialsMode: "personal_default",
  });

  render(<CloudAppPage />);
  fireEvent.click(await screen.findByRole("button", { name: /Settings/ }));

  expect(await screen.findByText("Coding agent credentials")).toBeVisible();
  expect(screen.getByRole("button", { name: /Use personal default/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /Use separate org keys/ }));

  await waitFor(() =>
    expect(apiMocks.updateProviderSettings).toHaveBeenCalledWith("org-one", {
      agentCredentialsMode: "custom",
    }),
  );
});

it("opens provider settings for the selected organization from manage keys", async () => {
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

  render(<CloudAppPage />);

  fireEvent.click(await screen.findByRole("button", { name: /Settings/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Manage keys" }));

  expect(
    await screen.findByRole("heading", { name: "Provider connections" }),
  ).toBeVisible();
  expect(screen.getByText("Configuring providers for")).toBeVisible();
  expect(screen.getAllByText("Team One")[0]).toBeVisible();
  expect(
    screen
      .getAllByRole("button", { name: /Team One/ })
      .some((button) => button.getAttribute("aria-current") === "true"),
  ).toBe(true);
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
  expect(await screen.findByLabelText("Role for user@example.com")).toBeDisabled();
  expect(screen.getByLabelText("Role for viewer@example.com")).not.toBeDisabled();
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

it("deletes a worker session from the session header", async () => {
  apiMocks.sessions.mockResolvedValue({ sessions: [worker] });
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

  render(<CloudAppPage />);

  const workerEntries = await screen.findAllByText("readme-reader");
  fireEvent.click(workerEntries[0]);
  fireEvent.click(await screen.findByLabelText("Delete readme-reader machine"));

  await waitFor(() =>
    expect(apiMocks.deleteSession).toHaveBeenCalledWith("org-one", "worker-one"),
  );
  expect(confirmSpy).toHaveBeenCalled();
  confirmSpy.mockRestore();
});

it("polls a selected connecting worker until runtime capabilities arrive", async () => {
  apiMocks.sessions.mockResolvedValue({ sessions: [worker] });
  apiMocks.session.mockResolvedValue({ session: worker });

  render(<CloudAppPage />);

  const workerEntries = await screen.findAllByText("readme-reader");
  fireEvent.click(workerEntries[0]);

  expect(await screen.findByText("Connecting worker")).toBeVisible();
  await waitFor(() =>
    expect(apiMocks.session).toHaveBeenCalledWith("org-one", "worker-one"),
  );
});

it("deletes a project from the project menu", async () => {
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

  render(<CloudAppPage />);

  fireEvent.click(await screen.findByLabelText("More actions for AO"));
  fireEvent.click(await screen.findByText("Delete project"));

  await waitFor(() =>
    expect(apiMocks.deleteProject).toHaveBeenCalledWith("org-one", "project-one"),
  );
  expect(confirmSpy).toHaveBeenCalled();
  confirmSpy.mockRestore();
});
