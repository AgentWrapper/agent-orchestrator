import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { AgentBrowserCDPBridge, type AgentBrowserTargetProvider } from "./agent-browser-cdp-bridge";

const MAX_ARGUMENTS = 100;
const MAX_ARGUMENT_CHARS = 16_384;
const MAX_OUTPUT_BYTES = 1 << 20;
const COMMAND_TIMEOUT_MS = 60_000;

const ALLOWED_COMMANDS = new Set([
	"open",
	"snapshot",
	"click",
	"dblclick",
	"focus",
	"type",
	"fill",
	"press",
	"keyboard",
	"keydown",
	"keyup",
	"hover",
	"select",
	"check",
	"uncheck",
	"scroll",
	"scrollintoview",
	"drag",
	"wait",
	"get",
	"is",
	"find",
	"tab",
	"frame",
	"dialog",
	"console",
	"errors",
	"highlight",
	"diff",
]);

const FORBIDDEN_FLAGS = [
	"--cdp",
	"--auto-connect",
	"--session",
	"--namespace",
	"--profile",
	"--state",
	"--restore",
	"--executable-path",
	"--extension",
	"--init-script",
	"--args",
	"--headers",
	"--proxy",
	"--plugin",
	"--allowed-domains",
];

export type AgentBrowserRunResult = {
	command: string;
	stdout: string;
	stderr: string;
	exitCode: number;
	untrustedExternalContent: true;
};

type NativeProcessResult = Pick<AgentBrowserRunResult, "stdout" | "stderr" | "exitCode">;

export type AgentBrowserRuntimeOptions = {
	enabled: boolean;
	binaryPath: string;
	log?: (message: string) => void;
};

type SessionRuntime = {
	bridge: AgentBrowserCDPBridge;
	endpoint: string;
	streamDisabled: boolean;
	namespace: string;
};

export class AgentBrowserRuntime {
	private readonly sessions = new Map<string, SessionRuntime>();
	private readonly log: (message: string) => void;

	constructor(private readonly options: AgentBrowserRuntimeOptions) {
		this.log = options.log ?? (() => undefined);
	}

	async run(
		sessionId: string,
		args: string[],
		provider: AgentBrowserTargetProvider,
		signal?: AbortSignal,
	): Promise<AgentBrowserRunResult> {
		if (!this.options.enabled) {
			throw runtimeError(
				"AGENT_BROWSER_DISABLED",
				"Native agent-browser is disabled. Set AO_AGENT_BROWSER_ENABLED=1 to enable the integration proof.",
			);
		}
		await this.assertBinary();
		validateAgentBrowserArguments(args);
		const runtime = await this.ensureSession(sessionId, provider);
		const environment = this.environment(runtime.endpoint, runtime.namespace);
		if (!runtime.streamDisabled) {
			const disabled = await runNativeProcess(
				this.options.binaryPath,
				["stream", "disable"],
				environment,
				signal,
			);
			if (disabled.exitCode !== 0) {
				throw runtimeError(
					"AGENT_BROWSER_START_FAILED",
					disabled.stderr.trim() || "Unable to disable agent-browser streaming",
				);
			}
			runtime.streamDisabled = true;
		}
		const result = await runNativeProcess(this.options.binaryPath, args, environment, signal);
		if (result.exitCode !== 0) {
			throw runtimeError(
				"AGENT_BROWSER_COMMAND_FAILED",
				result.stderr.trim() || result.stdout.trim() || `agent-browser exited with code ${result.exitCode}`,
			);
		}
		return { ...result, command: args[0], untrustedExternalContent: true };
	}

	async closeSession(sessionId: string): Promise<void> {
		const runtime = this.sessions.get(sessionId);
		if (!runtime) return;
		this.sessions.delete(sessionId);
		try {
			if (this.options.enabled) {
				await runNativeProcess(
					this.options.binaryPath,
					["close"],
					this.environment(runtime.endpoint, runtime.namespace),
					undefined,
					10_000,
				);
			}
		} catch (error) {
			this.log(`agent-browser close failed for ${sessionId}: ${String(error)}`);
		} finally {
			await runtime.bridge.close();
		}
	}

	async dispose(): Promise<void> {
		await Promise.all([...this.sessions.keys()].map((sessionId) => this.closeSession(sessionId)));
	}

	private async ensureSession(
		sessionId: string,
		provider: AgentBrowserTargetProvider,
	): Promise<SessionRuntime> {
		const existing = this.sessions.get(sessionId);
		if (existing) return existing;
		const bridge = new AgentBrowserCDPBridge(provider);
		const endpoint = await bridge.start();
		const runtime = {
			bridge,
			endpoint,
			streamDisabled: false,
			namespace: `${sessionNamespace(sessionId)}-${randomBytes(6).toString("hex")}`,
		};
		this.sessions.set(sessionId, runtime);
		return runtime;
	}

	private environment(endpoint: string, namespace: string): NodeJS.ProcessEnv {
		const environment: NodeJS.ProcessEnv = {
			...process.env,
			AGENT_BROWSER_CDP: endpoint,
			AGENT_BROWSER_SESSION: namespace,
			AGENT_BROWSER_NAMESPACE: namespace,
			AGENT_BROWSER_CONTENT_BOUNDARIES: "1",
			AGENT_BROWSER_MAX_OUTPUT: "50000",
			AGENT_BROWSER_IDLE_TIMEOUT_MS: "300000",
			AGENT_BROWSER_AUTO_CONNECT: "0",
		};
		for (const name of [
			"AGENT_BROWSER_RESTORE",
			"AGENT_BROWSER_PROFILE",
			"AGENT_BROWSER_STATE",
			"AGENT_BROWSER_EXECUTABLE_PATH",
			"AGENT_BROWSER_ALLOWED_DOMAINS",
		]) {
			delete environment[name];
		}
		return environment;
	}

	private async assertBinary(): Promise<void> {
		try {
			await access(this.options.binaryPath);
		} catch {
			throw runtimeError(
				"AGENT_BROWSER_NOT_INSTALLED",
				`Native agent-browser binary was not found at ${this.options.binaryPath}. Run npm run agent-browser:prepare.`,
			);
		}
	}
}

export function validateAgentBrowserArguments(args: string[]): void {
	if (args.length === 0) throw runtimeError("INVALID_ARGUMENT", "An agent-browser command is required");
	if (args.length > MAX_ARGUMENTS) throw runtimeError("INVALID_ARGUMENT", "Too many agent-browser arguments");
	if (args.some((arg) => typeof arg !== "string" || arg.length > MAX_ARGUMENT_CHARS)) {
		throw runtimeError("INVALID_ARGUMENT", "agent-browser arguments are invalid or too large");
	}
	const command = args[0].toLowerCase();
	if (!ALLOWED_COMMANDS.has(command)) {
		throw runtimeError("AGENT_BROWSER_COMMAND_BLOCKED", `agent-browser command is not enabled in AO: ${command}`);
	}
	for (const arg of args) {
		const lower = arg.toLowerCase();
		if (FORBIDDEN_FLAGS.some((flag) => lower === flag || lower.startsWith(`${flag}=`))) {
			throw runtimeError("AGENT_BROWSER_COMMAND_BLOCKED", `agent-browser flag is managed by AO: ${arg}`);
		}
	}
	if (command === "open" && args[1] && !args[1].startsWith("-")) {
		assertHTTPURL(args[1]);
	}
	if (command === "diff" && args[1]?.toLowerCase() !== "snapshot") {
		throw runtimeError("AGENT_BROWSER_COMMAND_BLOCKED", "Only snapshot diff is enabled in AO");
	}
	if (command === "get" && args[1]?.toLowerCase() === "cdp-url") {
		throw runtimeError("AGENT_BROWSER_COMMAND_BLOCKED", "The private AO CDP endpoint cannot be displayed");
	}
}

async function runNativeProcess(
	binaryPath: string,
	args: string[],
	environment: NodeJS.ProcessEnv,
	signal?: AbortSignal,
	timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<NativeProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(binaryPath, args, {
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let settled = false;
		const finish = (error?: Error, exitCode = -1) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else
				resolve({
					stdout: stdout.toString("utf8"),
					stderr: stderr.toString("utf8"),
					exitCode,
				});
		};
		const append = (
			current: Buffer<ArrayBufferLike>,
			chunk: Buffer<ArrayBufferLike>,
		): Buffer<ArrayBufferLike> => {
			if (current.length + chunk.length > MAX_OUTPUT_BYTES) {
				child.kill();
				finish(runtimeError("AGENT_BROWSER_OUTPUT_TOO_LARGE", "agent-browser output exceeded AO's limit"));
				return current;
			}
			return Buffer.concat([current, chunk]);
		};
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});
		child.once("error", (error) => finish(error));
		child.once("close", (code) => finish(undefined, code ?? -1));
		// The native CLI starts a long-lived daemon. On Windows that daemon can
		// briefly retain inherited pipe handles after the short-lived CLI exits,
		// delaying Node's `close` event even though the command is complete.
		// `exit` is therefore the primary completion signal; one event-loop turn
		// still lets already-buffered stdout/stderr data handlers drain.
		child.once("exit", (code) => setImmediate(() => finish(undefined, code ?? -1)));
		const abort = () => {
			child.kill();
			finish(runtimeError("AGENT_BROWSER_CANCELLED", "agent-browser command was cancelled"));
		};
		signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => {
			child.kill();
			finish(runtimeError("AGENT_BROWSER_TIMEOUT", "agent-browser command timed out"));
		}, timeoutMs);
		if (signal?.aborted) abort();
	});
}

function assertHTTPURL(raw: string): void {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw runtimeError("INVALID_URL", "agent-browser navigation requires an explicit HTTP(S) URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw runtimeError("BROWSER_URL_FORBIDDEN", `Unsupported browser URL scheme: ${url.protocol}`);
	}
}

function sessionNamespace(sessionId: string): string {
	return `ao-${createHash("sha256").update(sessionId).digest("hex").slice(0, 20)}`;
}

function runtimeError(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}
