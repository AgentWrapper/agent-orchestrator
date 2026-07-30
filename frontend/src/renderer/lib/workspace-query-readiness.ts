// Workspace queries must not run before Electron supplies a trusted daemon
// port, otherwise a startup request can replace the restored snapshot. Browser
// previews and unit tests have no Electron lifecycle, so they remain enabled.
const bypassDaemonReadiness = import.meta.env.MODE === "test" || import.meta.env.VITE_NO_ELECTRON === "1";
let daemonReady = false;

export function workspaceQueriesEnabled(): boolean {
	return bypassDaemonReadiness || daemonReady;
}

export function setWorkspaceQueriesEnabled(nextEnabled: boolean): void {
	daemonReady = nextEnabled;
}
