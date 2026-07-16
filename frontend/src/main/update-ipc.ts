import type { UpdateSettings, UpdateStatus } from "./update-settings";

export type UpdateIpcDeps = {
	isRemoteClientBuild: boolean;
	stateDir(): string | null;
	readSettings(stateDir: string): Promise<UpdateSettings>;
	writeSettings(stateDir: string, settings: UpdateSettings): Promise<void>;
	getStatus(): UpdateStatus;
	check(stateDir: string): Promise<void>;
	download(): Promise<void>;
	install(): void;
};

const disabledSettings: UpdateSettings = { enabled: false, channel: "latest", nightlyAck: false };
const unsupportedStatus: UpdateStatus = {
	state: "unsupported",
	message: "Updates are unavailable in remote client builds.",
};

export function createUpdateIpcHandlers(deps: UpdateIpcDeps) {
	return {
		getSettings: async (): Promise<UpdateSettings> => {
			if (deps.isRemoteClientBuild) return disabledSettings;
			const stateDir = deps.stateDir();
			return stateDir ? deps.readSettings(stateDir) : disabledSettings;
		},
		setSettings: async (settings: UpdateSettings): Promise<void> => {
			if (deps.isRemoteClientBuild) return;
			const stateDir = deps.stateDir();
			if (stateDir) await deps.writeSettings(stateDir, settings);
		},
		getStatus: (): UpdateStatus => (deps.isRemoteClientBuild ? unsupportedStatus : deps.getStatus()),
		check: async (): Promise<void> => {
			if (deps.isRemoteClientBuild) return;
			const stateDir = deps.stateDir();
			if (stateDir) await deps.check(stateDir);
		},
		download: async (): Promise<void> => {
			if (!deps.isRemoteClientBuild) await deps.download();
		},
		install: (): void => {
			if (!deps.isRemoteClientBuild) deps.install();
		},
	};
}
