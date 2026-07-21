"use client";

import { useSyncExternalStore } from "react";

const REPO_API_URL = "https://api.github.com/repos/AgentWrapper/agent-orchestrator";
const LATEST_RELEASE_API_URL = "https://api.github.com/repos/AgentWrapper/agent-orchestrator/releases/latest";

export interface RepoFacts {
	/** Compact star count, e.g. "8.4k". Null while loading or on failure. */
	stars: string | null;
	/** Latest stable release tag, e.g. "v0.10.3". Null while loading or on failure. */
	latestRelease: string | null;
}

export function formatCompactNumber(value: number): string {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}m`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(1)}k`;
	}
	return String(value);
}

/*
 * Shared store: the hero, nav, and final CTA all render repo facts, but the
 * unauthenticated GitHub API allows only 60 requests/hour per IP (and visitors
 * often share NAT egress). All hook instances read one cached result from a
 * single fetch per page load instead of each firing their own requests.
 */
let facts: RepoFacts = { stars: null, latestRelease: null };
let started = false;
const listeners = new Set<() => void>();

function emit() {
	listeners.forEach((listener) => listener());
}

async function load() {
	const headers = { Accept: "application/vnd.github+json" };
	try {
		const [repoRes, releaseRes] = await Promise.all([
			fetch(REPO_API_URL, { cache: "no-store", headers }),
			fetch(LATEST_RELEASE_API_URL, { cache: "no-store", headers }),
		]);

		const next: RepoFacts = { stars: null, latestRelease: null };
		if (repoRes.ok) {
			const repo = (await repoRes.json()) as { stargazers_count?: number };
			if (typeof repo.stargazers_count === "number") {
				next.stars = formatCompactNumber(repo.stargazers_count);
			}
		}
		if (releaseRes.ok) {
			const release = (await releaseRes.json()) as { tag_name?: string };
			if (typeof release.tag_name === "string" && release.tag_name.length > 0) {
				next.latestRelease = release.tag_name;
			}
		}

		if (next.stars !== facts.stars || next.latestRelease !== facts.latestRelease) {
			facts = next;
			emit();
		}
	} catch {
		// Keep the neutral placeholders if the browser cannot reach GitHub.
	}
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	if (!started) {
		started = true;
		void load();
	}
	return () => {
		listeners.delete(listener);
	};
}

function getSnapshot(): RepoFacts {
	return facts;
}

function getServerSnapshot(): RepoFacts {
	return facts;
}

/**
 * Live repo facts (stars, latest release) shared across all consumers.
 * Degrades silently to nulls so UI can hide the facts when offline/rate-limited.
 */
export function useGitHubRepoFacts(): RepoFacts {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
