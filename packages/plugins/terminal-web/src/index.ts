import type { PluginModule, Terminal, Session } from "@aoagents/ao-core";

export const manifest = {
  name: "web",
  slot: "terminal" as const,
  description: "Terminal plugin: xterm.js web terminal",
  version: "0.1.0",
};

/**
 * Web terminal plugin.
 *
 * Unlike iTerm2, this doesn't directly open anything — the web dashboard
 * uses xterm.js to connect to sessions via the runtime's attach info.
 * This plugin provides the URL generation and session-open tracking
 * that the dashboard needs.
 */
export function create(config?: Record<string, unknown>): Terminal {
  const dashboardUrl = (config?.dashboardUrl as string) ?? "http://localhost:3000";

  // Track which sessions have been "opened" (URL generated for the dashboard)
  const openSessions = new Set<string>();

  return {
    name: "web",

    async openSession(session: Session): Promise<void> {
      openSessions.add(session.id);
      // In a web context, "opening" means the dashboard should show the terminal.
      // The actual xterm.js connection is handled by the web dashboard frontend
      // using the session's runtime attach info.
      console.log(
        `[terminal-web] Session ${session.id} terminal available at ${dashboardUrl}/sessions/${session.id}/terminal`,
      );
    },

    async openAll(sessions: Session[]): Promise<void> {
      for (const session of sessions) {
        openSessions.add(session.id);
      }
      console.log(
        `[terminal-web] ${sessions.length} sessions available at ${dashboardUrl}/sessions`,
      );
    },

    async isSessionOpen(session: Session): Promise<boolean> {
      return openSessions.has(session.id);
    },
  };
}

export default { manifest, create } satisfies PluginModule<Terminal>;
