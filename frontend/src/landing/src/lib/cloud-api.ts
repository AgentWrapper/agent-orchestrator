import { env } from "@/env";

export interface CloudRepository {
  id?: number;
  fullName: string;
  url: string;
  defaultBranch: string;
  private: boolean;
}

export interface CloudGitHubInstallation {
  id: string;
  githubInstallationId: number;
  accountLogin: string;
  accountType: string;
  status: string;
  repositorySelection: string;
}

export interface CloudGitHubGrantedRepository {
  repository: {
    id: number;
    fullName: string;
    htmlUrl: string;
    defaultBranch: string;
    private: boolean;
    archived: boolean;
    disabled: boolean;
  };
  grant: {
    installationId: string;
    githubInstallationId: number;
    repositorySelection: string;
    grantedAt: string;
    lastSyncedAt: string;
  };
}

export interface CloudGitHubConnection {
  mode: "local-gh" | "github-app" | "disabled";
  appSlug: string;
  installations: CloudGitHubInstallation[];
  repositories: CloudGitHubGrantedRepository[];
}

export interface CloudGitHubPendingInstallation {
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  repositoryCount: number;
}

export interface CloudProject {
  id: string;
  orgId: string;
  displayName: string;
  repositoryUrl: string;
  defaultBranch: string;
  config: Record<string, unknown>;
}

export interface CloudOrganization {
  id: string;
  slug: string;
  displayName: string;
  kind: "personal" | "team" | "enterprise";
  plan: string;
  status: "active" | "disabled";
}

export interface CloudOrgMembership {
  id: string;
  orgId: string;
  userId: string;
  role: "owner" | "admin" | "member" | "viewer";
  status: "active" | "disabled";
}

export interface CloudUserOrganization {
  organization: CloudOrganization;
  membership: CloudOrgMembership;
}

export interface CloudUser {
  id: string;
  email: string;
  displayName: string;
}

export interface CloudOrgMember {
  user: CloudUser;
  membership: CloudOrgMembership;
}

export interface CloudOrgInvitation {
  id: string;
  orgId: string;
  email: string;
  invitedByEmail?: string;
  invitedByName?: string;
  role: "owner" | "admin" | "member" | "viewer";
  status: "pending" | "accepted" | "declined" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
}

export interface CloudSession {
  id: string;
  projectId: string;
  kind: "worker" | "orchestrator";
  harness: string;
  displayName: string;
  branch: string;
  activityState: "active" | "idle" | "waiting_input" | "blocked" | "exited";
  status:
    | "working"
    | "needs_input"
    | "pr_open"
    | "review_pending"
    | "ci_failed"
    | "changes_requested"
    | "approved"
    | "mergeable"
    | "merged"
    | "exited"
    | "idle"
    | "terminated";
  capabilities?: string[];
  runtimeConnected: boolean;
  activeTurn?: CloudTurn;
  isTerminated: boolean;
  createdAt: string;
}

export interface CloudSharedProject {
  id: string;
  orgId: string;
  project: CloudProject;
  session?: CloudSession;
  sessions?: CloudSession[];
  role: "viewer" | "editor";
  sharedByEmail: string;
  sharedByName: string;
  redeemedAt: string;
}

export interface CloudProjectShareRecipient {
  id: string;
  shareLinkId: string;
  recipientType: "email" | "org";
  email?: string;
  orgId?: string;
  orgName?: string;
  createdAt: string;
}

export interface CloudProjectShareLink {
  id: string;
  orgId: string;
  projectId: string;
  sessionId?: string;
  createdByUserId: string;
  role: "viewer" | "editor";
  status: "active" | "revoked";
  accessScope: "anyone" | "restricted";
  recipients?: CloudProjectShareRecipient[];
  createdAt: string;
  updatedAt: string;
}

export interface CloudProjectShareGrant {
  id: string;
  user: CloudUser;
  role: "viewer" | "editor";
  status: "active" | "revoked";
  redeemedAt: string;
  updatedAt: string;
}

export interface CloudProjectShareAccess {
  links: CloudProjectShareLink[];
  grants: CloudProjectShareGrant[];
}

export interface CloudTurn {
  id: string;
  sessionId: string;
  userMessageSequence: number;
  attemptCount: number;
  state:
    | "queued"
    | "provisioning"
    | "running"
    | "cancel_requested"
    | "completed"
    | "failed";
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudEvent {
  sessionId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CloudWorkspaceEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mode: string;
  modTime: string;
}

export interface CloudWorkspaceDiff {
  status: string;
  unstaged: string;
  staged: string;
}

export interface CloudPreviewResponse {
  status: number;
  contentType: string;
  location: string;
  body: string;
  url: string;
}

export interface CloudPullRequestObservation {
  repository: string;
  number: number;
  url: string;
  title: string;
  state: string;
  draft: boolean;
  sourceBranch: string;
  targetBranch: string;
  ciState: string;
  reviewState: string;
  mergeability: string;
  checks?: Array<{
    name: string;
    status: string;
    conclusion: string;
    url: string;
  }>;
  reviewThreads?: CloudReviewThreadObservation[];
  observedAt: string;
}

export interface CloudReviewThreadObservation {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number;
  body: string;
  authorLogin: string;
  observedAt: string;
}

export interface CloudSessionSCM {
  pullRequest?: CloudPullRequestObservation;
  reviewThreads?: CloudReviewThreadObservation[];
}

export interface ProviderConnection {
  id: string;
  provider: "daytona" | "claude-code" | "codex" | "cursor";
  label: string;
  config: {
    apiUrl?: string;
    target?: "us" | "eu";
    credentialType?: AgentCredentialType;
  };
  validationState: "pending" | "valid" | "invalid";
  validatedAt?: string;
}

export type AgentCredentialsMode = "custom" | "personal_default";

export type CloudAgent = "claude-code" | "codex" | "cursor";
export type AgentCredentialType = "oauth_token" | "api_key" | "access_token";

export interface CloudAuthSession {
  accessToken: string;
  authProvider?: "local" | "workos";
  providerSessionToken?: string;
  user: {
    id: string;
    email: string;
    displayName: string;
  };
}

type FetchOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
};

export class CloudAPIError extends Error {
  readonly code?: string;
  readonly status: number;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "CloudAPIError";
    this.status = status;
    this.code = code;
  }
}

export class CloudAPI {
  readonly baseURL: string;
  readonly accessToken: string;

  constructor(accessToken: string) {
    if (!env.NEXT_PUBLIC_API_URL) {
      throw new Error("NEXT_PUBLIC_API_URL is not configured.");
    }
    this.baseURL = env.NEXT_PUBLIC_API_URL.replace(/\/+$/, "");
    this.accessToken = accessToken;
  }

  static async signUp(input: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<CloudAuthSession> {
    return CloudAPI.authRequest("/api/cloud/v1/auth/signup", input);
  }

  static async login(input: {
    email: string;
    password: string;
  }): Promise<CloudAuthSession> {
    return CloudAPI.authRequest("/api/cloud/v1/auth/login", input);
  }

  static async logout(accessToken: string): Promise<void> {
    await CloudAPI.authRequest("/api/cloud/v1/auth/logout", undefined, accessToken);
  }

  private static async authRequest<T = CloudAuthSession>(
    path: string,
    body?: unknown,
    accessToken?: string,
  ): Promise<T> {
    if (!env.NEXT_PUBLIC_API_URL) throw new Error("NEXT_PUBLIC_API_URL is not configured.");
    const headers = new Headers();
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    const response = await fetch(env.NEXT_PUBLIC_API_URL.replace(/\/+$/, "") + path, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(failure?.message ?? "Authentication failed.");
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async me() {
    return this.request<{
      user: CloudUser;
      sandboxProvider: "daytona" | "fly";
      organizations: CloudUserOrganization[];
    }>(
      "/api/cloud/v1/me",
    );
  }

  async updateProfile(input: { displayName: string }) {
    return this.request<{ user: CloudUser }>("/api/cloud/v1/me", {
      method: "PATCH",
      body: input,
    });
  }

  async organizations() {
    return this.request<{ organizations: CloudUserOrganization[] }>(
      "/api/cloud/v1/orgs",
    );
  }

  async createOrganization(input: { displayName: string }) {
    return this.request<{ organization: CloudUserOrganization }>(
      "/api/cloud/v1/orgs",
      { method: "POST", body: input },
    );
  }

  async updateOrganization(orgId: string, input: { displayName: string }) {
    return this.request<{ organization: CloudOrganization }>(
      this.orgPath(orgId, "/"),
      { method: "PATCH", body: input },
    );
  }

  async invitations() {
    return this.request<{ invitations: CloudOrgInvitation[] }>(
      "/api/cloud/v1/invitations",
    );
  }

  async acceptInvitation(invitationId: string) {
    return this.request<{ membership: CloudOrgMembership }>(
      `/api/cloud/v1/invitations/${encodeURIComponent(invitationId)}/accept`,
      { method: "POST", body: {} },
    );
  }

  async declineInvitation(invitationId: string) {
    return this.request<void>(
      `/api/cloud/v1/invitations/${encodeURIComponent(invitationId)}/decline`,
      { method: "POST", body: {} },
    );
  }

  async orgInvitations(orgId: string) {
    return this.request<{ invitations: CloudOrgInvitation[] }>(
      this.orgPath(orgId, "/invitations"),
    );
  }

  async orgMembers(orgId: string) {
    return this.request<{ members: CloudOrgMember[] }>(
      this.orgPath(orgId, "/members"),
    );
  }

  async updateOrgMemberRole(
    orgId: string,
    userId: string,
    input: { role: CloudOrgMembership["role"] },
  ) {
    return this.request<{ member: CloudOrgMember }>(
      this.orgPath(orgId, `/members/${encodeURIComponent(userId)}`),
      { method: "PATCH", body: input },
    );
  }

  async inviteToOrg(orgId: string, input: { email: string; role: string }) {
    return this.request<{ invitation: CloudOrgInvitation }>(
      this.orgPath(orgId, "/invitations"),
      { method: "POST", body: input },
    );
  }

  async revokeInvitation(orgId: string, invitationId: string) {
    return this.request<void>(
      this.orgPath(
        orgId,
        `/invitations/${encodeURIComponent(invitationId)}/revoke`,
      ),
      { method: "POST", body: {} },
    );
  }

  async repositories(orgId: string) {
    return this.request<{ repositories: CloudRepository[] }>(
      this.orgPath(orgId, "/repositories"),
    );
  }

  async githubConnection(orgId: string) {
    return this.request<CloudGitHubConnection>(
      this.orgPath(orgId, "/github"),
    );
  }

  async startGitHubInstall(orgId: string) {
    return this.request<{ installUrl: string }>(
      this.orgPath(orgId, "/github/install"),
      { method: "POST", body: {} },
    );
  }

  async pendingGitHubInstall(orgId: string, state: string) {
    return this.request<CloudGitHubPendingInstallation>(
      this.orgPath(orgId, "/github/install/pending"),
      { method: "POST", body: { state } },
    );
  }

  async confirmGitHubInstall(orgId: string, input: { state: string }) {
    return this.request<void>(
      this.orgPath(orgId, "/github/install/confirm"),
      { method: "POST", body: input },
    );
  }

  async syncGitHub(orgId: string) {
    return this.request<void>(
      this.orgPath(orgId, "/github/sync"),
      { method: "POST", body: {} },
    );
  }

  async disconnectGitHubInstallation(
    orgId: string,
    installationId: number,
  ) {
    return this.request<void>(
      this.orgPath(
        orgId,
        `/github/installations/${encodeURIComponent(installationId)}`,
      ),
      { method: "DELETE" },
    );
  }

  async projects(orgId: string) {
    return this.request<{ projects: CloudProject[] }>(
      this.orgPath(orgId, "/projects"),
    );
  }

  async createProject(orgId: string, input: {
    displayName: string;
    repositoryUrl: string;
    defaultBranch: string;
    githubRepositoryId?: number;
    config?: Record<string, unknown>;
  }) {
    return this.request<{ project: CloudProject }>(this.orgPath(orgId, "/projects"), {
      method: "POST",
      body: input,
    });
  }

  async deleteProject(orgId: string, projectId: string) {
    return this.request<void>(
      this.orgPath(orgId, `/projects/${encodeURIComponent(projectId)}`),
      { method: "DELETE" },
    );
  }

  async createProjectShareLink(
    orgId: string,
    projectId: string,
    input: {
      sessionId?: string;
      role: "viewer" | "editor";
      accessScope?: "anyone" | "restricted";
      recipientEmails?: string[];
      recipientOrgIds?: string[];
    },
  ) {
    return this.request<{ token: string; shareLink: CloudProjectShareLink }>(
      this.orgPath(orgId, `/projects/${encodeURIComponent(projectId)}/shares`),
      { method: "POST", body: input },
    );
  }

  async projectShareAccess(orgId: string, projectId: string) {
    return this.request<{ access: CloudProjectShareAccess }>(
      this.orgPath(orgId, `/projects/${encodeURIComponent(projectId)}/shares`),
    );
  }

  async updateProjectShareGrant(
    orgId: string,
    projectId: string,
    grantId: string,
    input: { role: "viewer" | "editor" },
  ) {
    return this.request<{ grant: CloudProjectShareGrant }>(
      this.orgPath(
        orgId,
        `/projects/${encodeURIComponent(projectId)}/shares/grants/${encodeURIComponent(grantId)}`,
      ),
      { method: "PATCH", body: input },
    );
  }

  async revokeProjectShareGrant(
    orgId: string,
    projectId: string,
    grantId: string,
  ) {
    return this.request<void>(
      this.orgPath(
        orgId,
        `/projects/${encodeURIComponent(projectId)}/shares/grants/${encodeURIComponent(grantId)}`,
      ),
      { method: "DELETE" },
    );
  }

  async revokeProjectShareLink(orgId: string, projectId: string, linkId: string) {
    return this.request<void>(
      this.orgPath(
        orgId,
        `/projects/${encodeURIComponent(projectId)}/shares/links/${encodeURIComponent(linkId)}`,
      ),
      { method: "DELETE" },
    );
  }

  async redeemProjectShareLink(token: string) {
    return this.request<{ share: CloudSharedProject }>(
      `/api/cloud/v1/share-links/${encodeURIComponent(token)}/redeem`,
      { method: "POST", body: {} },
    );
  }

  async sharedProjects() {
    return this.request<{ shares: CloudSharedProject[] }>("/api/cloud/v1/shares");
  }

  async sessions(orgId: string) {
    return this.request<{ sessions: CloudSession[] }>(
      this.orgPath(orgId, "/sessions"),
    );
  }

  async session(orgId: string, sessionId: string) {
    return this.request<{ session: CloudSession }>(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}`),
    );
  }

  async activeTurn(orgId: string, sessionId: string) {
    return this.request<{ turn: CloudTurn | null }>(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}/active-turn`),
    );
  }

  async sessionSCM(orgId: string, sessionId: string) {
    return this.request<{ scm: CloudSessionSCM | null }>(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}/scm`),
    );
  }

  async createSession(
    orgId: string,
    input: {
      projectId: string;
      kind: CloudSession["kind"];
      harness: string;
      displayName: string;
      prompt: string;
      providerConnectionId?: string;
    },
    idempotencyKey: string,
  ) {
    return this.request<{ session: CloudSession }>(this.orgPath(orgId, "/sessions"), {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: input,
    });
  }

  async setDesiredState(
    orgId: string,
    sessionId: string,
    state: "running" | "paused" | "deleted",
  ) {
    return this.request<{ ok: boolean; state: string }>(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}/desired-state`),
      { method: "POST", body: { state } },
    );
  }

  async deleteSession(orgId: string, sessionId: string) {
    return this.request<void>(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}`),
      { method: "DELETE" },
    );
  }

  async chatEvents(orgId: string, sessionId: string, after = 0, limit = 500) {
    return this.request<{ events: CloudEvent[] }>(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}/chat-events?after=${after}&limit=${limit}`),
    );
  }

  async sendMessage(orgId: string, sessionId: string, text: string, idempotencyKey: string) {
    return this.request<{ event: CloudEvent }>(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}/messages`),
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: { text },
      },
    );
  }

  async interruptSession(orgId: string, sessionId: string) {
    return this.request<{ event: CloudEvent }>(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}/interrupt`),
      { method: "POST", body: {} },
    );
  }

  async streamEvents(
    orgId: string,
    sessionId: string,
    after: number,
    signal: AbortSignal,
    onEvent: (event: CloudEvent) => void,
    onActivity?: () => void,
  ) {
    const target = new URL(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}/events`),
      this.baseURL,
    );
    target.searchParams.set("after", String(after));
    const response = await fetch(target, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${this.accessToken}`,
      },
      signal,
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => null)) as {
        message?: string;
        code?: string;
      } | null;
      throw new Error(
        failure?.message ??
          `AO Cloud event stream failed (${failure?.code ?? response.status}).`,
      );
    }
    if (!response.body) {
      throw new Error("AO Cloud event stream returned no response body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (value && value.byteLength > 0) onActivity?.();
        buffer += decoder
          .decode(value, { stream: !done })
          .replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) onEvent(JSON.parse(data) as CloudEvent);
          boundary = buffer.indexOf("\n\n");
        }
        if (done) return;
      }
    } finally {
      reader.releaseLock();
    }
  }

  async providerConnections(orgId: string) {
    return this.request<{
      providerConnections: ProviderConnection[];
      agentCredentialsMode: AgentCredentialsMode;
    }>(
      this.orgPath(orgId, "/provider-connections"),
    );
  }

  async updateProviderSettings(
    orgId: string,
    input: { agentCredentialsMode: AgentCredentialsMode },
  ) {
    return this.request<{
      agentCredentialsMode: AgentCredentialsMode;
      providerConnections: ProviderConnection[];
    }>(this.orgPath(orgId, "/provider-settings"), {
      method: "PATCH",
      body: input,
    });
  }

  async connectDaytona(orgId: string, input: {
    label: string;
    apiKey: string;
    apiUrl: string;
    target: "us" | "eu";
  }) {
    return this.request<{ providerConnection: ProviderConnection }>(
      this.orgPath(orgId, "/provider-connections/daytona"),
      { method: "PUT", body: input },
    );
  }

  async connectAgent(
    orgId: string,
    agent: CloudAgent,
    input: { credentialType: AgentCredentialType; secret: string },
  ) {
    return this.request<{ providerConnection: ProviderConnection }>(
      this.orgPath(orgId, `/provider-connections/agents/${encodeURIComponent(agent)}`),
      { method: "PUT", body: input },
    );
  }

  async disconnectAgent(orgId: string, agent: CloudAgent) {
    return this.request<void>(
      this.orgPath(orgId, `/provider-connections/agents/${encodeURIComponent(agent)}`),
      { method: "DELETE" },
    );
  }

  async terminalTicket(
    orgId: string,
    sessionId: string,
    kind: "agent" | "workspace" = "agent",
  ) {
    return this.request<{ ticket: string; expiresIn: number; scopes?: string[] }>(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}/terminal-ticket`),
      { method: "POST", body: { kind } },
    );
  }

  terminalURL(
    ticket: string,
    after = 0,
    kind: "agent" | "workspace" = "agent",
  ) {
    const target = new URL("/api/cloud/v1/terminal", this.baseURL);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    target.searchParams.set("ticket", ticket);
    target.searchParams.set("after", String(after));
    target.searchParams.set("kind", kind);
    return target.toString();
  }

  async workspaceFiles(orgId: string, sessionId: string, path = "") {
    const query = new URLSearchParams({ path });
    return this.request<{ path: string; entries: CloudWorkspaceEntry[] }>(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}/workspace/files?${query}`),
    );
  }

  async workspaceFile(orgId: string, sessionId: string, path: string) {
    const query = new URLSearchParams({ path });
    return this.request<{ path: string; content: string; size: number }>(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}/workspace/file?${query}`),
    );
  }

  async workspaceDiff(orgId: string, sessionId: string) {
    return this.request<CloudWorkspaceDiff>(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}/workspace/diff`),
    );
  }

  async workspacePreview(orgId: string, sessionId: string, port: number, path: string) {
    return this.request<CloudPreviewResponse>(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}/workspace/preview`),
      { method: "POST", body: { port, path, method: "GET" } },
    );
  }

  async workspacePreviewTicket(orgId: string, sessionId: string, port: number) {
    return this.request<{ url: string; expiresAt: string }>(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}/workspace/preview-ticket`),
      { method: "POST", body: { port } },
    );
  }

  async workspaceFilePreviewTicket(orgId: string, sessionId: string, path: string) {
    return this.request<{ url: string; expiresAt: string }>(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}/workspace/file-preview-ticket`),
      { method: "POST", body: { path } },
    );
  }

  private orgPath(orgId: string, path: string) {
    return `/api/cloud/v1/orgs/${encodeURIComponent(orgId)}${path}`;
  }

  private async request<T>(
    path: string,
    options: FetchOptions = {},
  ): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${this.accessToken}`);
    if (options.body !== undefined)
      headers.set("Content-Type", "application/json");
    const response = await fetch(this.baseURL + path, {
      ...options,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => null)) as {
        message?: string;
        code?: string;
      } | null;
      throw new CloudAPIError(
        failure?.message ??
          `AO Cloud request failed (${failure?.code ?? response.status}).`,
        response.status,
        failure?.code,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
