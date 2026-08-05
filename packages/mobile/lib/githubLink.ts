// Maps github.com web URLs to the GitHub mobile app's `github://` scheme. Pure
// and free of React Native imports so it can be unit-tested directly — the
// Linking side lives in `openGitHub.ts`, mirroring how `pushStatus.ts` pairs
// with `push.ts`.
//
// Why this exists: a private repo opened in the phone's browser shows a login
// wall or a 404, because the browser has no GitHub session. The app does. So we
// hand the app anything it can render and leave the rest to the browser.
//
// Deliberately conservative. The `github://` scheme is undocumented and its
// supported paths have changed across app releases, so we only translate the
// three shapes that have been stable, and return null for everything else
// rather than risk deep-linking into a dead end. A null means "use the browser".

/** Path segments of a github.com URL, or null if it isn't one. */
function segments(url: string): string[] | null {
	// Hand-rolled rather than `new URL()`: React Native's URL polyfill is
	// incomplete, and this runs on-device.
	const m = /^https?:\/\/(?:www\.)?github\.com(\/[^?#]*)?/i.exec(url.trim());
	if (!m) return null;
	return (m[1] ?? "").split("/").filter(Boolean);
}

const isNumeric = (s: string) => /^\d+$/.test(s);

/**
 * The `github://` equivalent of a github.com URL, or null when the app has no
 * equivalent screen and the browser should be used instead.
 *
 * Notably null for `/issues/new?body=…`: the app cannot accept a prefilled
 * issue body, so sending "Report a problem" there would silently drop the
 * diagnostics it attaches.
 */
export function githubAppUrl(url: string): string | null {
	const seg = segments(url);
	if (!seg || seg.length < 2) return null;
	const [owner, repo, ...rest] = seg;
	// Reserved roots that look like an owner but aren't (/settings/…, /orgs/…).
	if (owner.startsWith("_") || RESERVED_ROOTS.has(owner.toLowerCase())) return null;
	const base = `github://repo/${owner}/${repo}`;
	if (rest.length === 0) return base;
	if (rest.length === 2 && (rest[0] === "pull" || rest[0] === "issues") && isNumeric(rest[1])) {
		return `${base}/${rest[0]}/${rest[1]}`;
	}
	return null;
}

const RESERVED_ROOTS = new Set([
	"settings",
	"orgs",
	"organizations",
	"notifications",
	"explore",
	"marketplace",
	"pulls",
	"issues",
	"search",
	"login",
	"join",
	"about",
	"features",
	"sponsors",
	"apps",
	"topics",
	"collections",
	"trending",
	"new",
	"codespaces",
]);
