// Watches a terminal output stream for http(s) URLs and reports each new one
// exactly once. Used to "glow" the Browser tab when an agent prints a link
// (e.g. a pushed-PR URL) without the user having to click it. Detection only
// badges — it never navigates — so occasional imprecision is harmless.
//
// The stream arrives in arbitrary chunks with ANSI escape codes and a URL can
// straddle a chunk boundary, so we strip ANSI, keep a small carry-over tail, and
// defer a match that ends exactly at the buffer edge (it may be truncated) until
// more output arrives.

// CSI/other escape sequences (ESC 0x1B or single-byte CSI 0x9B, plus params and
// a final byte). Built from string escapes so the source stays pure ASCII.
const ANSI_PATTERN = new RegExp("[\\u001B\\u009B][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]", "g");
const URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>()[\]{}]+/gi;
// Characters that commonly trail a URL in prose/logs but are not part of it.
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

const TAIL_MAX = 2048;
const SEEN_MAX = 512;

export type UrlWatcher = {
	/** Feed a decoded output chunk; fires the callback for each new URL. */
	push: (chunk: string) => void;
	/** Forget the tail and seen-set (call on session/handle change). */
	reset: () => void;
};

function stripTrailingPunct(url: string): string {
	return url.replace(TRAILING_PUNCT, "");
}

export function createUrlWatcher(onUrl: (url: string) => void): UrlWatcher {
	let tail = "";
	let seen = new Set<string>();

	return {
		push(chunk: string) {
			if (!chunk) return;
			const text = (tail + chunk).replace(ANSI_PATTERN, "");
			URL_PATTERN.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = URL_PATTERN.exec(text)) !== null) {
				const end = match.index + match[0].length;
				// A match flush against the buffer end may be truncated mid-URL by a
				// chunk split — leave it for the next push (it survives in `tail`).
				if (end === text.length) break;
				const url = stripTrailingPunct(match[0]);
				if (!url || seen.has(url)) continue;
				if (seen.size >= SEEN_MAX) seen = new Set();
				seen.add(url);
				onUrl(url);
			}
			tail = text.length > TAIL_MAX ? text.slice(text.length - TAIL_MAX) : text;
		},
		reset() {
			tail = "";
			seen = new Set();
		},
	};
}
