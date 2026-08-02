import { env } from "@/env";

export interface CloudRepository {
  fullName: string;
  url: string;
  defaultBranch: string;
  private: boolean;
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

export interface CloudOrgInvitation {
  id: string;
  orgId: string;
  email: string;
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

export type CloudAgent = "claude-code" | "codex" | "cursor";
export type AgentCredentialType = "oauth_token" | "api_key" | "access_token";

export interface CloudAuthSession {
  accessToken: string;
  user: {
    id: string;
    email: string;
    displayName: string;
  };
}

type FetchOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
};

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
      sandboxProvider: "daytona" | "fly";
      organizations: CloudUserOrganization[];
    }>(
      "/api/cloud/v1/me",
    );
  }

  async organizations() {
    return this.request<{ organizations: CloudUserOrganization[] }>(
      "/api/cloud/v1/orgs",
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

  async projects(orgId: string) {
    return this.request<{ projects: CloudProject[] }>(
      this.orgPath(orgId, "/projects"),
    );
  }

  async createProject(orgId: string, input: {
    displayName: string;
    repositoryUrl: string;
    defaultBranch: string;
    config?: Record<string, unknown>;
  }) {
    return this.request<{ project: CloudProject }>(this.orgPath(orgId, "/projects"), {
      method: "POST",
      body: input,
    });
  }

  async sessions(orgId: string) {
    return this.request<{ sessions: CloudSession[] }>(
      this.orgPath(orgId, "/sessions"),
    );
  }

  async activeTurn(orgId: string, sessionId: string) {
    return this.request<{ turn: CloudTurn | null }>(
      this.orgPath(orgId, `/sessions/${encodeURIComponent(sessionId)}/active-turn`),
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
    return this.request<{ providerConnections: ProviderConnection[] }>(
      this.orgPath(orgId, "/provider-connections"),
    );
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
    return this.request<{ ticket: string; expiresIn: number }>(
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
      throw new Error(
        failure?.message ??
          `AO Cloud request failed (${failure?.code ?? response.status}).`,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
