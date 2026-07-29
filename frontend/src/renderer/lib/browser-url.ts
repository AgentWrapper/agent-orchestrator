// Pure URL-normalization / omnibox heuristics for the browser panel, ported
// verbatim from `frontend/src/main/browser-view-host.ts` (the Electron main
// process). These are plain functions with no Electron/Tauri dependency, so
// under Tauri they run directly in the renderer (the equivalent hardening on
// the Rust side, `browser::nav::is_allowed_protocol`, re-validates the
// protocol allowlist independently as defense-in-depth — see
// `frontend/src-tauri/src/browser/nav.rs`).
import type { BrowserRect } from "../../shared/bridge-types";

// ponytail: file:// allowed unsanitized; preview targets are agent-trusted for now
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:"]);

export function normalizeBrowserURL(input: string): URL {
	const raw = input.trim();
	if (raw === "") {
		throw new Error("URL is required");
	}
	const candidate = withDefaultScheme(raw);
	const url = new URL(candidate);
	if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
		throw new Error(`Unsupported browser URL scheme: ${url.protocol}`);
	}
	return url;
}

export function isAllowedBrowserURL(input: string, rendererOrigin?: string): boolean {
	try {
		const url = normalizeBrowserURL(input);
		if (rendererOrigin && url.origin === rendererOrigin) return false;
		return true;
	} catch {
		return false;
	}
}

export function clampBoundsToWindow(
	rect: BrowserRect,
	windowBounds: Pick<BrowserRect, "width" | "height">,
): BrowserRect {
	const rounded = {
		x: Math.round(rect.x),
		y: Math.round(rect.y),
		width: Math.max(0, Math.round(rect.width)),
		height: Math.max(0, Math.round(rect.height)),
	};
	const maxX = Math.max(0, Math.round(windowBounds.width));
	const maxY = Math.max(0, Math.round(windowBounds.height));
	const x = Math.min(Math.max(rounded.x, 0), maxX);
	const y = Math.min(Math.max(rounded.y, 0), maxY);
	return {
		x,
		y,
		width: Math.min(rounded.width, Math.max(0, maxX - x)),
		height: Math.min(rounded.height, Math.max(0, maxY - y)),
	};
}

export function scaleBoundsForZoom(rect: BrowserRect, zoomFactor: number): BrowserRect {
	if (!Number.isFinite(zoomFactor) || zoomFactor <= 0 || zoomFactor === 1) return rect;
	return {
		x: rect.x * zoomFactor,
		y: rect.y * zoomFactor,
		width: rect.width * zoomFactor,
		height: rect.height * zoomFactor,
	};
}

function withDefaultScheme(raw: string): string {
	if (isWindowsAbsolutePath(raw) || isPosixAbsolutePath(raw)) return localPathToFileURL(raw);
	if (/^https?:\/\//i.test(raw)) return raw;
	if (isLocalhostLike(raw)) return `http://${raw}`;
	// A single token with no whitespace can be a destination: an explicit scheme
	// (file:, mailto:, ...) or a bare hostname we default to https. Anything else —
	// whitespace-containing text, or a lone word that is not a hostname — is a
	// search query, not a URL (Chrome-style omnibox behavior).
	if (!/\s/.test(raw)) {
		if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) return raw;
		if (looksLikeHost(raw)) return `https://${raw}`;
	}
	return searchURL(raw);
}

// Treat input as a navigable host when the authority (the part before any
// path/query/fragment) is an IPv6 literal, carries an explicit :port, or has a
// dot (a domain). Bare words like "hi" fail this and become a search instead.
function looksLikeHost(raw: string): boolean {
	const host = raw.split(/[/?#]/, 1)[0];
	if (host === "") return false;
	if (host.startsWith("[") && host.includes("]")) return true;
	if (/:\d+$/.test(host)) return true;
	return host.includes(".");
}

function searchURL(query: string): string {
	return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function isWindowsAbsolutePath(raw: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(raw);
}

function isPosixAbsolutePath(raw: string): boolean {
	return raw.startsWith("/");
}

function localPathToFileURL(raw: string): string {
	if (isWindowsAbsolutePath(raw)) {
		const normalized = raw.replace(/\\/g, "/");
		return `file:///${encodePathSegments(normalized).replace(/^([A-Za-z])%3A(?=\/)/, "$1:")}`;
	}
	return `file://${encodePathSegments(raw)}`;
}

function encodePathSegments(pathname: string): string {
	return pathname.split("/").map(encodeURIComponent).join("/");
}

function isLocalhostLike(raw: string): boolean {
	return /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(raw);
}
