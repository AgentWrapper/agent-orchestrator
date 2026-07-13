import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ProviderCredentials {
	apiKey?: string;
	baseURL?: string;
	authToken?: string;
}

/** File holding the user's provider credentials under the ~/.ao state dir. */
export const PROVIDER_CREDENTIALS_FILE_NAME = "provider-credentials.json";

function coerce(raw: unknown): ProviderCredentials {
	const o = (raw ?? {}) as Record<string, unknown>;
	const out: ProviderCredentials = {};
	if (typeof o.apiKey === "string" && o.apiKey) out.apiKey = o.apiKey;
	if (typeof o.baseURL === "string" && o.baseURL) out.baseURL = o.baseURL;
	if (typeof o.authToken === "string" && o.authToken) out.authToken = o.authToken;
	return out;
}

/** Read provider credentials, tolerating a missing or corrupt file (returns {}). */
export async function readProviderCredentials(stateDir: string): Promise<ProviderCredentials> {
	let raw: string;
	try {
		raw = await readFile(path.join(stateDir, PROVIDER_CREDENTIALS_FILE_NAME), "utf8");
	} catch {
		return {};
	}
	try {
		return coerce(JSON.parse(raw));
	} catch {
		return {};
	}
}

/** Atomically write provider credentials (temp file + rename) with mode 0o600. */
export async function writeProviderCredentials(stateDir: string, creds: ProviderCredentials): Promise<void> {
	await mkdir(stateDir, { recursive: true, mode: 0o750 });
	const file = path.join(stateDir, PROVIDER_CREDENTIALS_FILE_NAME);
	const data = `${JSON.stringify(coerce(creds), null, 2)}\n`;
	const tmp = path.join(stateDir, `.provider-credentials-${process.pid}-${Date.now()}.json`);
	await writeFile(tmp, data, { mode: 0o600 });
	await rename(tmp, file);
}
