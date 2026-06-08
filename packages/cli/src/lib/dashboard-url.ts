/**
 * Returns the user-facing base URL of the dashboard.
 *
 * When `AO_PUBLIC_URL` is set in the environment, AO is being fronted by a
 * reverse proxy (e.g. when running inside a remote dev container or behind
 * Caddy/nginx). All console output, `ao open` browser launches, and session
 * URLs surfaced to humans should use that public URL instead of localhost.
 *
 * The trailing slash is stripped for consistency so callers can append paths
 * without producing `//`.
 *
 * Internal IPC (the daemon hitting its own dashboard's API) is intentionally
 * **not** routed through this helper — those calls always use localhost since
 * they happen on the same host as the dashboard process.
 *
 * @param port - the local dashboard port; only used in the localhost fallback
 */
export function dashboardUrl(port: number): string {
  const publicUrl = process.env.AO_PUBLIC_URL?.trim();
  if (publicUrl) {
    return publicUrl.replace(/\/+$/, "");
  }
  return `http://localhost:${port}`;
}
