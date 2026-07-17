export function resolveRemoteClientBuild(input: {
	isPackaged: boolean;
	envOverride: boolean;
	markerExists: boolean;
}): boolean {
	return input.isPackaged ? input.markerExists : input.envOverride;
}

export function shouldUseCanonicalAppState(remoteClient: boolean): boolean {
	return !remoteClient;
}

export type RemoteClientIdentity = {
	productName: string;
	appBundleId: string;
	executableName: string;
	userDataDirectoryName: string;
};

export function resolveRemoteClientIdentity(remoteClient: boolean): RemoteClientIdentity {
	return remoteClient
		? {
				productName: "Agent Orchestrator Remote",
				appBundleId: "dev.agent-orchestrator.desktop.remote",
				executableName: "agent-orchestrator-remote",
				userDataDirectoryName: "electron-remote",
			}
		: {
				productName: "Agent Orchestrator",
				appBundleId: "dev.agent-orchestrator.desktop",
				executableName: "agent-orchestrator",
				userDataDirectoryName: "electron",
			};
}
