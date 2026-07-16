export type SCMProvider = "github" | "gitlab";

export function deriveProviderRepo(remote: string | undefined, provider: SCMProvider): string | undefined {
	const trimmed = remote?.trim();
	if (!trimmed) return undefined;

	let path: string | undefined;
	const scpLike = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
	if (scpLike) {
		path = scpLike[1];
	} else {
		try {
			path = new URL(trimmed).pathname;
		} catch {
			path = trimmed;
		}
	}

	const parts = path
		.replace(/\.git$/, "")
		.replace(/^\/+|\/+$/g, "")
		.split("/")
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length < 2) return undefined;
	return (provider === "github" ? parts.slice(-2) : parts).join("/");
}

export function deriveRepositoryHref(remote?: string, repo?: string): string | undefined {
	const trimmed = remote?.trim();
	if (!trimmed) return undefined;
	const scpLike = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
	if (scpLike) {
		const path = repo?.trim() || scpLike[2];
		return `https://${scpLike[1]}/${cleanRepoPath(path)}`;
	}
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		url.pathname = `/${cleanRepoPath(repo?.trim() || url.pathname)}`;
		return url.toString().replace(/\/$/, "");
	} catch {
		return undefined;
	}
}

export function deriveGitLabApiBaseUrl(webBaseUrl: string): string {
	try {
		const url = new URL(webBaseUrl.trim());
		if (url.protocol !== "https:" && url.protocol !== "http:") return "";
		url.search = "";
		url.hash = "";
		url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/v4`;
		return url.toString().replace(/\/$/, "");
	} catch {
		return "";
	}
}

export function defaultSCMWebBaseUrl(provider: SCMProvider): string {
	return provider === "gitlab" ? "https://gitlab.com" : "https://github.com";
}

export function defaultSCMApiBaseUrl(provider: SCMProvider, webBaseUrl: string): string {
	return provider === "gitlab" ? deriveGitLabApiBaseUrl(webBaseUrl) : "https://api.github.com";
}

function cleanRepoPath(path: string): string {
	return path.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
}
