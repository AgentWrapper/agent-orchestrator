/**
 * HTTP client for Jira Cloud REST API v3.
 *
 * Handles authentication, retry logic, and rate limiting.
 * Modelled after the Bitbucket HTTP client pattern used in scm-bitbucket.
 */

export interface JiraClientConfig {
  /** Jira domain — e.g. "mycompany" becomes mycompany.atlassian.net, or a full domain */
  domain: string;
  /** Jira account email */
  email: string;
  /** Jira API token */
  apiToken: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Max retries on transient failures (default: 3) */
  maxRetries?: number;
}

export function createJiraClient(config: JiraClientConfig) {
  const baseUrl = config.domain.includes(".")
    ? `https://${config.domain}/rest/api/3`
    : `https://${config.domain}.atlassian.net/rest/api/3`;
  const timeout = config.timeout ?? 30_000;
  const maxRetries = config.maxRetries ?? 3;
  const authHeader =
    "Basic " + Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(path.startsWith("https://") || path.startsWith("http://") ? path : `${baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url.toString(), {
          method,
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.status === 429) {
          await res.body?.cancel().catch(() => {}); // release socket
          const retryAfter = Math.min(60, Math.max(1, parseInt(res.headers.get("Retry-After") ?? "5", 10) || 5));
          await sleep(retryAfter * 1000);
          continue;
        }
        if (res.status >= 500 && attempt < maxRetries) {
          await res.body?.cancel().catch(() => {}); // release socket
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Jira API ${method} ${path} failed (${res.status}): ${text}`);
        }
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof Error && err.name === "AbortError") {
          lastError = new Error(
            `Jira API ${method} ${path} timed out after ${timeout}ms`,
          );
        } else if (err instanceof Error && err.message.includes("Jira API")) {
          throw err;
        } else {
          lastError = err as Error;
        }
        if (attempt < maxRetries) {
          await sleep(1000 * Math.pow(2, attempt));
        }
      }
    }
    throw lastError ?? new Error(`Jira API ${method} ${path} failed after ${maxRetries} retries`);
  }

  return {
    get: <T>(path: string, params?: Record<string, string>) =>
      request<T>("GET", path, undefined, params),
    post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
    put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
    del: <T>(path: string) => request<T>("DELETE", path),
  };
}

export type JiraClient = ReturnType<typeof createJiraClient>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
