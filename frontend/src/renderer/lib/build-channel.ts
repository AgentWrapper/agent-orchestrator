export function isNightlyBuild(version?: string): boolean {
	return version?.includes("-nightly.") ?? false;
}

export function isCommandPaletteEnabled(version?: string, isDev: boolean = import.meta.env.DEV): boolean {
	return isDev || isNightlyBuild(version);
}
