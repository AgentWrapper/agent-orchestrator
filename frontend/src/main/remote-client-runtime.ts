import { safeDaemonStatusDetail, type DaemonFailureCode, type DaemonStatus } from "../shared/daemon-status";
import { RemoteForwarderStartError, type RemoteForwarder } from "./remote-forwarder";
import {
	validateRemoteServerConfigInput,
	RemoteServerConfigError,
	type RemoteServerConfig,
	type RemoteServerConfigInput,
} from "./remote-server-config";

type RemoteProbeFailureCode = Extract<
	DaemonFailureCode,
	"remote_bad_password" | "remote_rate_limited" | "remote_http_error" | "identity_mismatch"
>;

class RemoteProbeError extends Error {
	constructor(
		readonly code: RemoteProbeFailureCode,
		readonly httpStatus?: number,
	) {
		super(code);
		this.name = "RemoteProbeError";
	}
}

export type PublicRemoteServerConfig = Pick<RemoteServerConfigInput, "host" | "port">;
export type EditableRemoteServerConfig = PublicRemoteServerConfig & { passwordConfigured: boolean };
export type RemoteServerConfigUpdate = PublicRemoteServerConfig & { password?: string };

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
	private lifecycleQueue: Promise<void> = Promise.resolve();

	constructor(private readonly deps: RemoteClientRuntimeDeps) {}

	getStatus(): DaemonStatus {
		return this.status;
	}

	getConfig(): PublicRemoteServerConfig | null {
		return this.config ? { host: this.config.host, port: this.config.port } : null;
	}

	getEditableConfig(): EditableRemoteServerConfig | null {
		return this.config
			? { host: this.config.host, port: this.config.port, passwordConfigured: this.config.password.length > 0 }
			: null;
	}

	revealPassword(): string | null {
		return this.config?.password ?? null;
	}

	start(): Promise<DaemonStatus> {
		return this.enqueueLifecycle(() => this.startNow());
	}

	private async startNow(): Promise<DaemonStatus> {
		if (this.forwarder) return this.status;
		const config = await this.deps.readConfig();
		if (!config) {
			return this.setStatus({
				state: "error",
				code: "not_configured",
			});
		}
		this.config = config;

		try {
			const next = await this.startValidatedForwarder(config);
			this.forwarder = next;
			return this.setStatus({ state: "ready", port: next.port });
		} catch (error) {
			return this.setStatus(remoteFailureStatus(error, "daemon_unreachable"));
		}
	}

	saveConfig(input: RemoteServerConfigUpdate): Promise<DaemonStatus> {
		return this.enqueueLifecycle(() => this.saveConfigNow(input));
	}

	private async saveConfigNow(input: RemoteServerConfigUpdate): Promise<DaemonStatus> {
		let candidate: RemoteForwarder | null = null;
		try {
			const normalized = validateRemoteServerConfigInput({
				host: input.host,
				port: input.port,
				password: input.password ?? this.config?.password ?? "",
			});
			candidate = await this.startValidatedForwarder(normalized);
			let saved: RemoteServerConfig;
			try {
				saved = await this.deps.writeConfig(normalized);
			} catch (error) {
				await candidate.close();
				return remoteFailureStatus(error, "remote_config_save_failed");
			}

			const previous = this.forwarder;
			this.forwarder = candidate;
			this.config = saved;
			candidate = null;
			await previous?.close();
			return this.setStatus({ state: "ready", port: this.forwarder.port });
		} catch (error) {
			await candidate?.close();
			return remoteFailureStatus(error, "daemon_unreachable");
		}
	}

	stop(): Promise<DaemonStatus> {
		return this.enqueueLifecycle(() => this.stopNow());
	}

	private async stopNow(): Promise<DaemonStatus> {
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

	private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.lifecycleQueue.then(operation);
		this.lifecycleQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private setStatus(status: DaemonStatus): DaemonStatus {
		this.status = status;
		this.deps.onStatus(status);
		return status;
	}
}

function remoteFailureStatus(error: unknown, fallbackCode: DaemonFailureCode): DaemonStatus {
	if (error instanceof RemoteServerConfigError) {
		return { state: "error", code: error.code };
	}
	if (error instanceof RemoteProbeError) {
		return {
			state: "error",
			code: error.code,
			...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
		};
	}
	if (error instanceof RemoteForwarderStartError) {
		return { state: "error", code: error.code };
	}
	const message = error instanceof Error ? safeDaemonStatusDetail(error) : undefined;
	return {
		state: "error",
		code: fallbackCode,
		...(message ? { message } : {}),
	};
}

export async function probeRemoteForwarder(port: number): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5_000);
	try {
		const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
		if (!response.ok) {
			if (response.status === 401) throw new RemoteProbeError("remote_bad_password");
			if (response.status === 429) throw new RemoteProbeError("remote_rate_limited");
			throw new RemoteProbeError("remote_http_error", response.status);
		}
		let body: { service?: unknown };
		try {
			body = (await response.json()) as { service?: unknown };
		} catch {
			throw new RemoteProbeError("identity_mismatch");
		}
		if (body.service !== "agent-orchestrator-daemon") {
			throw new RemoteProbeError("identity_mismatch");
		}
	} finally {
		clearTimeout(timeout);
	}
}
