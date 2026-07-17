export type SCMProvider = "github" | "gitlab";

export function deriveProviderRepo(
	remote: string | undefined,
	provider: SCMProvider,
	webBaseUrl?: string,
): string | undefined {
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

	const repoPath = stripBasePath(cleanRepoPath(path), webBaseUrl);
	const parts = repoPath
		.split("/")
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length < 2) return undefined;
	return (provider === "github" ? parts.slice(-2) : parts).join("/");
}

export function deriveRepositoryHref(remote?: string, repo?: string, webBaseUrl?: string): string | undefined {
	const trimmed = remote?.trim();
	if (!trimmed) return undefined;
	const repository = cleanRepoPath(repo?.trim() || remotePath(trimmed) || "");
	if (!repository) return undefined;
	const configuredBase = httpBaseUrl(webBaseUrl);
	if (configuredBase) {
		configuredBase.pathname = joinURLPath(configuredBase.pathname, repository);
		return configuredBase.toString().replace(/\/$/, "");
	}
	const scpLike = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
	if (scpLike) {
		const originalPath = cleanRepoPath(scpLike[2]);
		const basePath = repo ? pathBeforeSuffix(originalPath, repository) : "";
		return `https://${scpLike[1]}/${joinPath(basePath, repository)}`;
	}
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		const originalPath = cleanRepoPath(url.pathname);
		const basePath = repo ? pathBeforeSuffix(originalPath, repository) : "";
		url.pathname = `/${joinPath(basePath, repository)}`;
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

function remotePath(remote: string): string | undefined {
	const scpLike = remote.match(/^[^@]+@[^:]+:(.+)$/);
	if (scpLike) return scpLike[1];
	try {
		return new URL(remote).pathname;
	} catch {
		return remote;
	}
}

function stripBasePath(path: string, webBaseUrl?: string): string {
	const base = httpBaseUrl(webBaseUrl);
	const basePath = cleanRepoPath(base?.pathname ?? "");
	return basePath && (path === basePath || path.startsWith(`${basePath}/`))
		? path.slice(basePath.length).replace(/^\/+/, "")
		: path;
}

function httpBaseUrl(value?: string): URL | undefined {
	if (!value?.trim()) return undefined;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url;
	} catch {
		return undefined;
	}
}

function pathBeforeSuffix(path: string, suffix: string): string {
	return path === suffix || !path.endsWith(`/${suffix}`) ? "" : path.slice(0, -(suffix.length + 1));
}

function joinURLPath(base: string, repository: string): string {
	return `/${joinPath(cleanRepoPath(base), repository)}`;
}

function joinPath(base: string, repository: string): string {
	return [cleanRepoPath(base), cleanRepoPath(repository)].filter(Boolean).join("/");
}
