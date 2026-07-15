import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const REMOTE_SERVER_CONFIG_FILE_NAME = "remote-server.json";

export type RemoteServerConfigInput = {
	host: string;
	port: number;
	password: string;
};

export type RemoteServerConfig = RemoteServerConfigInput & {
	updatedAt: string;
};

export type ConfigCrypto = {
	encrypt(value: string): Buffer;
	decrypt(value: Buffer): string;
};

type StoredRemoteServerConfig = {
	host: string;
	port: number;
	encryptedPassword: string;
	updatedAt: string;
};

export function validateRemoteServerConfigInput(input: RemoteServerConfigInput): RemoteServerConfigInput {
	const host = input.host.trim();
	if (!host) throw new Error("Server host is required");
	if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
		throw new Error("Server port must be an integer from 1 to 65535");
	}
	if (!input.password) throw new Error("Connection password is required");
	return { host, port: input.port, password: input.password };
}

export async function readRemoteServerConfig(
	stateDir: string,
	crypto: ConfigCrypto,
): Promise<RemoteServerConfig | null> {
	try {
		const raw = await readFile(path.join(stateDir, REMOTE_SERVER_CONFIG_FILE_NAME), "utf8");
		const stored = JSON.parse(raw) as StoredRemoteServerConfig;
		const password = crypto.decrypt(Buffer.from(stored.encryptedPassword, "base64"));
		const input = validateRemoteServerConfigInput({ host: stored.host, port: stored.port, password });
		if (typeof stored.updatedAt !== "string" || Number.isNaN(Date.parse(stored.updatedAt))) return null;
		return { ...input, updatedAt: stored.updatedAt };
	} catch {
		return null;
	}
}

export async function writeRemoteServerConfig(
	stateDir: string,
	input: RemoteServerConfigInput,
	crypto: ConfigCrypto,
): Promise<RemoteServerConfig> {
	const normalized = validateRemoteServerConfigInput(input);
	const encryptedPassword = crypto.encrypt(normalized.password).toString("base64");
	const updatedAt = new Date().toISOString();
	const stored: StoredRemoteServerConfig = {
		host: normalized.host,
		port: normalized.port,
		encryptedPassword,
		updatedAt,
	};

	await mkdir(stateDir, { recursive: true, mode: 0o700 });
	const file = path.join(stateDir, REMOTE_SERVER_CONFIG_FILE_NAME);
	const tmp = path.join(stateDir, `.remote-server-${process.pid}-${Date.now()}.json`);
	try {
		await writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
		await rename(tmp, file);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}

	return { ...normalized, updatedAt };
}
