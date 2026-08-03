// Build identity for the About section. The formatting is split from the Expo
// lookup so it can be unit-tested without a native runtime — the same split as
// pushStatus.ts / push.ts.

/** Just the fields we read off expo-constants. */
export type BuildInfo = {
	version?: string | null;
	// iOS build number / Android versionCode, as a string.
	build?: string | null;
};

/**
 * "1.2.0 (42)", or "1.2.0" when the build number is missing or merely repeats
 * the version (Expo Go reports them identically, and "1.2.0 (1.2.0)" is noise).
 * Falls back to "unknown" rather than rendering an empty row.
 */
export function formatVersion(info: BuildInfo): string {
	const version = info.version?.trim();
	const build = info.build?.trim();
	if (!version) return build ? `build ${build}` : "unknown";
	if (!build || build === version) return version;
	return `${version} (${build})`;
}

/** A one-line device/build string for prefilling a bug report. */
export function bugReportBody(info: BuildInfo, platform: string, osVersion: string | number): string {
	return [
		"",
		"",
		"---",
		`AO mobile: ${formatVersion(info)}`,
		`Platform: ${platform} ${osVersion}`,
	].join("\n");
}
