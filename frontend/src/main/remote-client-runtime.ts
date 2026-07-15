import type { DaemonStatus } from "../shared/daemon-status";
import type { RemoteForwarder } from "./remote-forwarder";
import {
	validateRemoteServerConfigInput,
	type RemoteServerConfig,
	type RemoteServerConfigInput,
} from "./remote-server-config";

export type PublicRemoteServerConfig = Pick<RemoteServerConfigInput, "host" | "port">;

export type RemoteClientRuntimeDeps = {
	readConfig(): Promise<RemoteServerConfig | null>;
	writeConfig(input: RemoteServerConfigInput): Promise<RemoteServerConfig>;
	startForwarder(input: RemoteServerConfigInput): Promise<RemoteForwarder>;
	probe(port: number): Promise<void>;
	onStatus(status: DaemonStatus): void;
};

export class RemoteClientRuntime {
	private config: RemoteServerConfig | null = null;
	private forwarder: RemoteForwarder | null = null;
	private status: DaemonStatus = { state: "stopped" };

	constructor(private readonly deps: RemoteClientRuntimeDeps) {}

	getStatus(): DaemonStatus {
		return this.status;
	}

	getConfig(): PublicRemoteServerConfig | null {
		return this.config ? { host: this.config.host, port: this.config.port } : null;
	}

	async start(): Promise<DaemonStatus> {
		if (this.forwarder) return this.status;
		const config = await this.deps.readConfig();
		if (!config) {
			return this.setStatus({
				state: "error",
				code: "not_configured",
				message: "Configure the remote AO server to continue.",
			});
		}

		try {
			const next = await this.startValidatedForwarder(config);
			this.config = config;
			this.forwarder = next;
			return this.setStatus({ state: "ready", port: next.port });
		} catch (error) {
			return this.setStatus({
				state: "error",
				code: "daemon_unreachable",
				message: errorMessage(error),
			});
		}
	}

	async saveConfig(input: RemoteServerConfigInput): Promise<DaemonStatus> {
		let candidate: RemoteForwarder | null = null;
		try {
			const normalized = validateRemoteServerConfigInput(input);
			candidate = await this.startValidatedForwarder(normalized);
			let saved: RemoteServerConfig;
			try {
				saved = await this.deps.writeConfig(normalized);
			} catch (error) {
				await candidate.close();
				return {
					state: "error",
					code: "not_configured",
					message: errorMessage(error),
				};
			}

			const previous = this.forwarder;
			this.forwarder = candidate;
			this.config = saved;
			candidate = null;
			await previous?.close();
			return this.setStatus({ state: "ready", port: this.forwarder.port });
		} catch (error) {
			await candidate?.close();
			return {
				state: "error",
				code: "daemon_unreachable",
				message: errorMessage(error),
			};
		}
	}

	async stop(): Promise<DaemonStatus> {
		const active = this.forwarder;
		this.forwarder = null;
		await active?.close();
		return this.setStatus({ state: "stopped" });
	}

	private async startValidatedForwarder(config: RemoteServerConfigInput): Promise<RemoteForwarder> {
		const forwarder = await this.deps.startForwarder(config);
		try {
			await this.deps.probe(forwarder.port);
			return forwarder;
		} catch (error) {
			await forwarder.close();
			throw error;
		}
	}

	private setStatus(status: DaemonStatus): DaemonStatus {
		this.status = status;
		this.deps.onStatus(status);
		return status;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Remote AO daemon is unavailable.";
}

export async function probeRemoteForwarder(port: number): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5_000);
	try {
		const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
		if (!response.ok) {
			if (response.status === 401) throw new Error("Connection password is invalid.");
			if (response.status === 429) throw new Error("Too many failed connection attempts. Try again shortly.");
			throw new Error(`Remote AO daemon returned HTTP ${response.status}.`);
		}
		const body = (await response.json()) as { service?: unknown };
		if (body.service !== "agent-orchestrator-daemon") {
			throw new Error("The configured server is not an AO daemon.");
		}
	} finally {
		clearTimeout(timeout);
	}
}
