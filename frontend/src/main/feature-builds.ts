import { readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

const GITHUB_API = "https://api.github.com";

// Default when the baked app-update.yml cannot be read (dev, or a malformed
// bundle). Matches forge.config.ts DEFAULT_RELEASE_REPO.
const DEFAULT_REPO = { owner: "AgentWrapper", repo: "agent-orchestrator" } as const;

// Resolve the GitHub repo the app updates from by reading the same bundled
// app-update.yml that electron-updater uses. Both are baked from AO_RELEASE_REPO
// at build time, so this keeps the feature list and the updater on the SAME repo
// (a fork build lists that fork's feature releases, not AgentWrapper's).
let cachedRepo: { owner: string; repo: string } | undefined;
function resolveRepo(): { owner: string; repo: string } {
	if (cachedRepo) return cachedRepo;
	cachedRepo = { ...DEFAULT_REPO };
	try {
		if (app.isPackaged) {
			const yml = readFileSync(path.join(process.resourcesPath, "app-update.yml"), "utf8");
			const owner = /^owner:\s*(.+)$/m.exec(yml)?.[1]?.trim();
			const repo = /^repo:\s*(.+)$/m.exec(yml)?.[1]?.trim();
			if (owner && repo) cachedRepo = { owner, repo };
		}
	} catch {
		// Keep the default on any read/parse failure.
	}
	return cachedRepo;
}

// Marker embedded in feature-build release bodies by the CI workflow.
const FEATURE_BUILD_MARKER = "<!-- ao-feature-build:";

// Feature builds older than this are dropped from the list.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface FeatureBuild {
	pr: number;
	title: string;
	base: string;
	sha: string;
	slug: string;
	/** The version/tag of the build (e.g. "1.2.3-pr2270.0"). */
	buildId: string;
	publishedAt: string;
}

/**
 * Parse a version string for a feature-build prerelease identifier.
 * Matches "-pr<N>." (with optional leading "v"). Returns { pr } or null.
 * Mirrors frontend/scripts/feature-version.mjs's parser, kept local to avoid
 * a cross-dir import from the main process into the build-scripts directory.
 */
export function parseFeatureBuild(version: string): { pr: number } | null {
	const m = version.match(/-pr(\d+)\./);
	if (!m) return null;
	const pr = parseInt(m[1], 10);
	return Number.isFinite(pr) && pr > 0 ? { pr } : null;
}

/** Return the feature-build pin for the currently running app version, or null. */
export function getActiveFeatureBuild(): { pr: number } | null {
	return parseFeatureBuild(app.getVersion());
}

interface GitHubRelease {
	tag_name: string;
	name: string;
	prerelease: boolean;
	published_at: string;
	body: string | null;
}

interface MarkerPayload {
	pr: number;
	base: string;
	sha: string;
	slug: string;
}

function parseMarker(body: string): MarkerPayload | null {
	const idx = body.indexOf(FEATURE_BUILD_MARKER);
	if (idx === -1) return null;
	// Marker format: <!-- ao-feature-build: {"pr":2270,"base":"main","sha":"abc","slug":"..."} -->
	const start = idx + FEATURE_BUILD_MARKER.length;
	const end = body.indexOf("-->", start);
	if (end === -1) return null;
	try {
		const payload = JSON.parse(body.slice(start, end).trim()) as MarkerPayload;
		if (typeof payload.pr !== "number" || typeof payload.base !== "string") return null;
		return payload;
	} catch {
		return null;
	}
}

async function fetchJson<T>(url: string): Promise<T> {
	const res = await fetch(url, {
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": `ao-desktop/${app.getVersion()}`,
		},
	});
	if (!res.ok) throw new Error(`GitHub API ${res.status}: ${url}`);
	return res.json() as Promise<T>;
}

async function isPrOpen(pr: number): Promise<boolean> {
	try {
		const { owner, repo } = resolveRepo();
		const data = await fetchJson<{ state: string }>(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${pr}`);
		return data.state === "open";
	} catch {
		// ponytail: unauthenticated GitHub API hits the 60 req/hr limit; per-PR-state
		// calls are batched/deduped below but could still be exhausted on large lists.
		// Upgrade path: pass the app's OAuth token (if one exists) in the Authorization
		// header to raise the limit to 5000 req/hr.
		//
		// On any error keep the entry rather than incorrectly filtering it out.
		return true;
	}
}

/**
 * List available feature builds from GitHub releases.
 *
 * Filters: prerelease=true AND body contains the ao-feature-build marker AND
 * published within the last 7 days AND PR is still open.
 * Groups by PR, keeping the newest build per PR. Returns sorted newest-first.
 * Never throws: returns [] on network or HTTP errors.
 */
export async function listFeatureBuilds(): Promise<FeatureBuild[]> {
	let releases: GitHubRelease[];
	try {
		const { owner, repo } = resolveRepo();
		// Fetch up to 100 releases; feature builds are always recent so this is plenty.
		releases = await fetchJson<GitHubRelease[]>(`${GITHUB_API}/repos/${owner}/${repo}/releases?per_page=100`);
	} catch (err) {
		console.warn("[feature-builds] failed to fetch releases:", err);
		return [];
	}

	const now = Date.now();
	const cutoff = now - MAX_AGE_MS;

	// Parse candidates: prerelease, within age window, valid marker.
	interface Candidate extends FeatureBuild {
		publishedMs: number;
	}

	const candidates: Candidate[] = [];
	for (const rel of releases) {
		if (!rel.prerelease) continue;
		const publishedMs = new Date(rel.published_at).getTime();
		if (publishedMs < cutoff) continue;
		const body = rel.body ?? "";
		const marker = parseMarker(body);
		if (!marker) continue;
		candidates.push({
			pr: marker.pr,
			title: rel.name,
			base: marker.base,
			sha: marker.sha,
			slug: marker.slug,
			buildId: rel.tag_name,
			publishedAt: rel.published_at,
			publishedMs,
		});
	}

	if (candidates.length === 0) return [];

	// Dedupe PR numbers for the open-state batch check.
	const uniquePrs = [...new Set(candidates.map((c) => c.pr))];
	const openMap = new Map<number, boolean>();
	await Promise.all(
		uniquePrs.map(async (pr) => {
			openMap.set(pr, await isPrOpen(pr));
		}),
	);

	// Keep only open PRs, then group by PR keeping the newest build per PR.
	const bestByPr = new Map<number, Candidate>();
	for (const c of candidates) {
		if (!openMap.get(c.pr)) continue;
		const existing = bestByPr.get(c.pr);
		if (!existing || c.publishedMs > existing.publishedMs) {
			bestByPr.set(c.pr, c);
		}
	}

	// Sort newest-first by publishedMs.
	const results = [...bestByPr.values()].sort((a, b) => b.publishedMs - a.publishedMs);

	// Strip the internal publishedMs field before returning.
	return results.map(({ publishedMs: _ms, ...rest }) => rest);
}
