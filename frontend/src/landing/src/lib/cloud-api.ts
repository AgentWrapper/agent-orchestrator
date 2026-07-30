import { env } from "@/env";

export interface CloudRepository {
  fullName: string;
  url: string;
  defaultBranch: string;
  private: boolean;
}

export interface CloudProject {
  id: string;
  displayName: string;
  repositoryUrl: string;
  defaultBranch: string;
  config: Record<string, unknown>;
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
  isTerminated: boolean;
  createdAt: string;
}

export interface CloudEvent {
  sessionId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
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

  async me() {
    return this.request<{ sandboxProvider: "daytona" | "fly" }>(
      "/api/cloud/v1/me",
    );
  }

  async repositories() {
    return this.request<{ repositories: CloudRepository[] }>(
      "/api/cloud/v1/repositories",
    );
  }

  async projects() {
    return this.request<{ projects: CloudProject[] }>("/api/cloud/v1/projects");
  }

  async createProject(input: {
    displayName: string;
    repositoryUrl: string;
    defaultBranch: string;
    config?: Record<string, unknown>;
  }) {
    return this.request<{ project: CloudProject }>("/api/cloud/v1/projects", {
      method: "POST",
      body: input,
    });
  }

  async sessions() {
    return this.request<{ sessions: CloudSession[] }>("/api/cloud/v1/sessions");
  }

  async createSession(
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
    return this.request<{ session: CloudSession }>("/api/cloud/v1/sessions", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: input,
    });
  }

  async setDesiredState(
    sessionId: string,
    state: "running" | "paused" | "deleted",
  ) {
    return this.request<{ ok: boolean; state: string }>(
      `/api/cloud/v1/sessions/${encodeURIComponent(sessionId)}/desired-state`,
      { method: "POST", body: { state } },
    );
  }

  async chatEvents(sessionId: string, after = 0, limit = 500) {
    return this.request<{ events: CloudEvent[] }>(
      `/api/cloud/v1/sessions/${encodeURIComponent(sessionId)}/chat-events?after=${after}&limit=${limit}`,
    );
  }

  async sendMessage(sessionId: string, text: string, idempotencyKey: string) {
    return this.request<{ event: CloudEvent }>(
      `/api/cloud/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: { text },
      },
    );
  }

  async interruptSession(sessionId: string) {
    return this.request<{ event: CloudEvent }>(
      `/api/cloud/v1/sessions/${encodeURIComponent(sessionId)}/interrupt`,
      { method: "POST", body: {} },
    );
  }

  async streamEvents(
    sessionId: string,
    after: number,
    signal: AbortSignal,
    onEvent: (event: CloudEvent) => void,
  ) {
    const target = new URL(
      `/api/cloud/v1/sessions/${encodeURIComponent(sessionId)}/events`,
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
        buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
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

  async providerConnections() {
    return this.request<{ providerConnections: ProviderConnection[] }>(
      "/api/cloud/v1/provider-connections",
    );
  }

  async connectDaytona(input: {
    label: string;
    apiKey: string;
    apiUrl: string;
    target: "us" | "eu";
  }) {
    return this.request<{ providerConnection: ProviderConnection }>(
      "/api/cloud/v1/provider-connections/daytona",
      { method: "PUT", body: input },
    );
  }

  async connectAgent(
    agent: CloudAgent,
    input: { credentialType: AgentCredentialType; secret: string },
  ) {
    return this.request<{ providerConnection: ProviderConnection }>(
      `/api/cloud/v1/provider-connections/agents/${encodeURIComponent(agent)}`,
      { method: "PUT", body: input },
    );
  }

  async disconnectAgent(agent: CloudAgent) {
    return this.request<void>(
      `/api/cloud/v1/provider-connections/agents/${encodeURIComponent(agent)}`,
      { method: "DELETE" },
    );
  }

  async terminalTicket(sessionId: string) {
    return this.request<{ ticket: string; expiresIn: number }>(
      `/api/cloud/v1/sessions/${encodeURIComponent(sessionId)}/terminal-ticket`,
      { method: "POST", body: {} },
    );
  }

  terminalURL(ticket: string, after = 0) {
    const target = new URL("/api/cloud/v1/terminal", this.baseURL);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    target.searchParams.set("ticket", ticket);
    target.searchParams.set("after", String(after));
    return target.toString();
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
