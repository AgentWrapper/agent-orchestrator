import type { components } from "../../api/schema";
import type { CloudDevSettings } from "../stores/ui-store";
import { createTerminalMux, muxUrlFromApiBase, type TerminalMux } from "./terminal-mux";

type CloudRequestOptions = {
	method?: string;
	body?: unknown;
	auth?: boolean;
};

type CloudProjectInput = {
	id: string;
	name?: string;
	repoUrl: string;
	defaultBranch?: string;
	workerAgent?: string;
	permissions?: string;
};

type CloudDevTokenResponse = {
	accessToken?: string;
	orgs?: Array<{ ID?: string; id?: string }>;
};

export function normalizeCloudBaseUrl(url: string): string {
	return url.trim().replace(/\/+$/, "");
}

export function cloudDevReady(settings: CloudDevSettings): boolean {
	return (
		settings.enabled &&
		normalizeCloudBaseUrl(settings.apiBaseUrl) !== "" &&
		settings.accessToken.trim() !== "" &&
		settings.orgId.trim() !== "" &&
		settings.projectId.trim() !== ""
	);
}

export function cloudDevTerminalMuxURL(settings: CloudDevSettings): string {
	const url = new URL(muxUrlFromApiBase(normalizeCloudBaseUrl(settings.apiBaseUrl)));
	url.searchParams.set("access_token", settings.accessToken.trim());
	if (settings.orgId.trim()) url.searchParams.set("org_id", settings.orgId.trim());
	return url.toString();
}

export function createCloudDevTerminalMux(settings: CloudDevSettings): TerminalMux {
	return createTerminalMux(cloudDevTerminalMuxURL(settings));
}

export async function createCloudDevToken(settings: CloudDevSettings): Promise<{ accessToken: string; orgId: string }> {
	const data = await cloudFetch<CloudDevTokenResponse>(settings, "/auth/dev/token", {
		method: "POST",
		auth: false,
		body: {
			email: settings.devAuthEmail,
			name: settings.devAuthName,
		},
	});
	const accessToken = data.accessToken?.trim() ?? "";
	const orgId = data.orgs?.[0]?.ID?.trim() || data.orgs?.[0]?.id?.trim() || "";
	if (!accessToken || !orgId) throw new Error("ao-cloud dev auth returned no access token or org");
	return { accessToken, orgId };
}

export async function registerCloudProject(settings: CloudDevSettings, input: CloudProjectInput): Promise<void> {
	await cloudFetch(settings, "/api/v1/cloud/projects", {
		method: "POST",
		body: {
			id: input.id,
			name: input.name || input.id,
			repoUrl: input.repoUrl,
			defaultBranch: input.defaultBranch,
			workerAgent: input.workerAgent,
			permissions: input.permissions,
		},
	});
}

export async function spawnCloudDevSession(
	settings: CloudDevSettings,
	body: components["schemas"]["SpawnSessionRequest"],
): Promise<components["schemas"]["SpawnSessionResponse"]> {
	return cloudFetch<components["schemas"]["SpawnSessionResponse"]>(settings, "/api/v1/sessions", {
		method: "POST",
		body,
	});
}

export async function fetchCloudDevJSON<T>(settings: CloudDevSettings, path: string): Promise<T> {
	return cloudFetch<T>(settings, path);
}

async function cloudFetch<T = unknown>(
	settings: CloudDevSettings,
	path: string,
	options: CloudRequestOptions = {},
): Promise<T> {
	const baseUrl = normalizeCloudBaseUrl(settings.apiBaseUrl);
	if (!baseUrl) throw new Error("AO Cloud URL is required");
	const headers = new Headers();
	headers.set("Accept", "application/json");
	if (options.body !== undefined) headers.set("Content-Type", "application/json");
	if (options.auth !== false) {
		if (!settings.accessToken.trim()) throw new Error("AO Cloud access token is required");
		headers.set("Authorization", `Bearer ${settings.accessToken.trim()}`);
		if (settings.orgId.trim()) headers.set("X-AO-Org-ID", settings.orgId.trim());
	}
	const response = await fetch(`${baseUrl}${path}`, {
		method: options.method ?? "GET",
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const text = await response.text();
	const data = text ? (JSON.parse(text) as T) : ({} as T);
	if (!response.ok) throw new Error(cloudErrorMessage(data, `AO Cloud request failed (${response.status})`));
	return data;
}

function cloudErrorMessage(error: unknown, fallback: string): string {
	if (typeof error === "object" && error !== null) {
		const body = error as { code?: unknown; message?: unknown };
		const code = typeof body.code === "string" && body.code ? body.code : "";
		if (typeof body.message === "string" && body.message) {
			return code && !body.message.includes(code) ? `${body.message} (${code})` : body.message;
		}
	}
	return fallback;
}
