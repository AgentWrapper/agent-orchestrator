export function resolveRemoteClientBuild(input: {
	isPackaged: boolean;
	envOverride: boolean;
	markerExists: boolean;
}): boolean {
	return input.isPackaged ? input.markerExists : input.envOverride;
}
