// Pure version math shared by the nightly CI workflow. Kept dependency-free
// ESM so `node scripts/nightly-version.mjs` runs it directly in CI and vitest
// unit-tests it. The app does NOT compute versions; it only reads its injected
// app.getVersion(), so this lives in scripts/, not src/.

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

// computeNightlyVersion builds X.Y.(Z+1)-nightly.<YYYYMMDDHHMM>+<shortSha>.
// Next-patch base keeps a nightly ahead of the last stable and behind the next.
// The fixed-width UTC timestamp makes prerelease ids order by build time; the
// sha is semver build metadata (ignored for ordering, kept for traceability).
export function computeNightlyVersion(latestStableTag, now, shortSha) {
	const bare = String(latestStableTag).replace(/^(desktop-)?v/, "");
	const m = SEMVER.exec(bare);
	if (!m) {
		throw new Error(`nightly-version: base tag is not X.Y.Z: ${latestStableTag}`);
	}
	const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const ts =
		String(now.getUTCFullYear()) +
		String(now.getUTCMonth() + 1).padStart(2, "0") +
		String(now.getUTCDate()).padStart(2, "0") +
		String(now.getUTCHours()).padStart(2, "0") +
		String(now.getUTCMinutes()).padStart(2, "0");
	return `${major}.${minor}.${patch + 1}-nightly.${ts}+${shortSha}`;
}

// CLI entry for CI: node scripts/nightly-version.mjs <latestStableTag> <shortSha>
if (import.meta.url === `file://${process.argv[1]}`) {
	const [, , latestStableTag, shortSha] = process.argv;
	if (!latestStableTag || !shortSha) {
		process.stderr.write("usage: node nightly-version.mjs <latestStableTag> <shortSha>\n");
		process.exit(2);
	}
	process.stdout.write(computeNightlyVersion(latestStableTag, new Date(), shortSha));
}
