// Pure version math shared by the feature-build CI workflow. Kept dependency-free
// ESM so `node scripts/feature-version.mjs` runs it directly in CI and vitest
// unit-tests it. The app does NOT compute versions; it only reads its injected
// app.getVersion(), so this lives in scripts/, not src/.

// computeFeatureVersion builds <baseVersion>-pr<pr>.<YYYYMMDDHHMM>+<shortSha>.
// baseVersion is used as-is (no patch bump) so the feature build is a prerelease
// of that exact base. The pr number is the semver prerelease identifier[0], which
// lets the update channel filter on `semver.prerelease(v)[0] === "pr<N>"`.
// The fixed-width UTC timestamp makes prerelease ids order by build time; the
// sha is semver build metadata (ignored for ordering, kept for traceability).
export function computeFeatureVersion(baseVersion, pr, shortSha, nowIso) {
	const bare = String(baseVersion).replace(/^(desktop-)?v/, "");
	const now = new Date(nowIso);
	const ts =
		String(now.getUTCFullYear()) +
		String(now.getUTCMonth() + 1).padStart(2, "0") +
		String(now.getUTCDate()).padStart(2, "0") +
		String(now.getUTCHours()).padStart(2, "0") +
		String(now.getUTCMinutes()).padStart(2, "0");
	return `${bare}-pr${pr}.${ts}+${shortSha}`;
}

// parseFeatureBuild extracts { pr, base } from a feature version string.
// Accepts versions with or without a leading `v` and with or without build
// metadata (the `+sha` suffix). Returns null for non-feature versions.
export function parseFeatureBuild(version) {
	const bare = String(version).replace(/^(desktop-)?v/, "");
	// Match: <base>-pr<digits>.<timestamp>[+<meta>]
	const m = /^(.+)-pr(\d+)\.\d{12}/.exec(bare);
	if (!m) return null;
	return { base: m[1], pr: Number(m[2]) };
}

// CLI entry for CI: node scripts/feature-version.mjs <baseVersion> <pr> <shortSha>
if (import.meta.url === `file://${process.argv[1]}`) {
	const [, , baseVersion, pr, shortSha] = process.argv;
	if (!baseVersion || !pr || !shortSha) {
		process.stderr.write("usage: node feature-version.mjs <baseVersion> <pr> <shortSha>\n");
		process.exit(2);
	}
	process.stdout.write(computeFeatureVersion(baseVersion, pr, shortSha, new Date().toISOString()));
}
