import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgentBrowserCDPBridge, type AgentBrowserTargetProvider } from "./agent-browser-cdp-bridge";

const MAX_ARGUMENTS = 100;
const MAX_ARGUMENT_CHARS = 16_384;
const MAX_OUTPUT_BYTES = 1 << 20;
const MAX_SCREENSHOT_BYTES = 5 << 20;
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
	"screenshot",
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
	binaryPath: string;
	dataDir: string;
	log?: (message: string) => void;
};

export type AgentBrowserJSONResult = Record<string, unknown>;

type SessionRuntime = {
	bridge: AgentBrowserCDPBridge;
	endpoint: string;
	streamDisabled: boolean;
	namespace: string;
	runtimeDir: string;
	configPath: string;
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
		await this.assertBinary();
		validateAgentBrowserArguments(args);
		const runtime = await this.ensureSession(sessionId, provider);
		const environment = this.environment(runtime);
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

	async runAction(
		sessionId: string,
		action: string,
		args: Record<string, unknown>,
		provider: AgentBrowserTargetProvider,
		signal?: AbortSignal,
	): Promise<AgentBrowserJSONResult> {
		const nativeArgs = nativeArgumentsForAction(action, args);
		const result = await this.run(sessionId, [...nativeArgs, "--json"], provider, signal);
		return parseAgentBrowserJSON(result.stdout);
	}

	async screenshot(
		sessionId: string,
		provider: AgentBrowserTargetProvider,
		signal?: AbortSignal,
	): Promise<{ data: string; width: number; height: number; untrustedExternalContent: true }> {
		const runtime = await this.ensureSession(sessionId, provider);
		const directory = await mkdtemp(path.join(runtime.runtimeDir, "screenshot-"));
		const target = path.join(directory, "screenshot.png");
		try {
			await this.run(sessionId, ["screenshot", target, "--json"], provider, signal);
			const image = await readFile(target);
			if (image.length > MAX_SCREENSHOT_BYTES) {
				throw runtimeError("AGENT_BROWSER_OUTPUT_TOO_LARGE", "Browser screenshot exceeded AO's size limit");
			}
			const { width, height } = pngDimensions(image);
			return { data: image.toString("base64"), width, height, untrustedExternalContent: true };
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}

	async closeSession(sessionId: string): Promise<void> {
		const runtime = this.sessions.get(sessionId);
		if (!runtime) return;
		this.sessions.delete(sessionId);
		try {
			await runNativeProcess(
				this.options.binaryPath,
				["close"],
				this.environment(runtime),
				undefined,
				10_000,
			);
		} catch (error) {
			this.log(`agent-browser close failed for ${sessionId}: ${String(error)}`);
		} finally {
			await runtime.bridge.close();
			await rm(runtime.runtimeDir, { recursive: true, force: true });
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
		const namespace = `${sessionNamespace(sessionId)}-${randomBytes(6).toString("hex")}`;
		const runtimeDir = path.join(this.options.dataDir, namespace);
		const configPath = path.join(runtimeDir, "config.json");
		await mkdir(runtimeDir, { recursive: true });
		await writeFile(configPath, "{}\n", "utf8");
		const runtime = {
			bridge,
			endpoint,
			streamDisabled: false,
			namespace,
			runtimeDir,
			configPath,
		};
		this.sessions.set(sessionId, runtime);
		return runtime;
	}

	private environment(runtime: SessionRuntime): NodeJS.ProcessEnv {
		const environment: NodeJS.ProcessEnv = { ...process.env };
		for (const name of Object.keys(environment)) {
			if (name.startsWith("AGENT_BROWSER_")) delete environment[name];
		}
		for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) delete environment[name];
		Object.assign(environment, {
			HOME: runtime.runtimeDir,
			USERPROFILE: runtime.runtimeDir,
			AGENT_BROWSER_CONFIG: runtime.configPath,
			AGENT_BROWSER_CDP: runtime.endpoint,
			AGENT_BROWSER_SESSION: runtime.namespace,
			AGENT_BROWSER_NAMESPACE: runtime.namespace,
			AGENT_BROWSER_CONTENT_BOUNDARIES: "1",
			AGENT_BROWSER_MAX_OUTPUT: "50000",
			AGENT_BROWSER_IDLE_TIMEOUT_MS: "300000",
			AGENT_BROWSER_AUTO_CONNECT: "0",
		});
		return environment;
	}

	private async assertBinary(): Promise<void> {
		try {
			await access(this.options.binaryPath);
		} catch {
			throw runtimeError(
				"AGENT_BROWSER_NOT_INSTALLED",
				`AO's browser automation component was not found at ${this.options.binaryPath}. Reinstall or rebuild the desktop app.`,
			);
		}
	}
}

export function nativeArgumentsForAction(action: string, args: Record<string, unknown>): string[] {
	const ref = () => nativeRef(stringValue(args.ref, "ref is required"));
	switch (action) {
		case "open":
			return ["open", httpURL(stringValue(args.url, "url is required"))];
		case "snapshot":
			return ["snapshot", ...(args.interactive === true ? ["--interactive"] : []), "--compact"];
		case "click":
		case "dblclick":
		case "focus":
		case "hover":
		case "highlight":
		case "scrollintoview":
		case "check":
		case "uncheck":
			return [action, ref()];
		case "fill":
		case "type":
			return [action, ref(), stringValue(args.text, "text is required", true)];
		case "press":
			return ["press", stringValue(args.key, "key is required")];
		case "drag":
			return ["drag", ref(), nativeRef(stringValue(args.targetRef, "target ref is required"))];
		case "select":
			return ["select", ref(), stringValue(args.value, "value is required", true)];
		case "tabs":
			return ["tab", "list"];
		case "tab-new": {
			const url = optionalStringValue(args.url);
			return ["tab", "new", ...(url ? [httpURL(url)] : [])];
		}
		case "tab-select":
			return ["tab", stringValue(args.tabId, "tabId is required")];
		case "tab-close": {
			const tabId = optionalStringValue(args.tabId);
			return ["tab", "close", ...(tabId ? [tabId] : [])];
		}
		case "scroll": {
			const direction = stringValue(args.direction, "direction is required").toLowerCase();
			if (!["up", "down", "left", "right"].includes(direction)) {
				throw runtimeError("INVALID_ARGUMENT", "direction must be up, down, left, or right");
			}
			const amount = numberValue(args.amount, 600, 1, 5_000);
			return ["scroll", direction, String(amount)];
		}
		case "get": {
			const property = stringValue(args.property, "property is required").toLowerCase();
			if (!["url", "title", "text", "value", "checked"].includes(property)) {
				throw runtimeError("INVALID_ARGUMENT", `Unsupported browser property: ${property}`);
			}
			const target = optionalStringValue(args.ref);
			if (["url", "title"].includes(property) && target) {
				throw runtimeError("INVALID_ARGUMENT", `${property} does not accept an element ref`);
			}
			if (["value", "checked"].includes(property) && !target) {
				throw runtimeError("REFERENCE_REQUIRED", `${property} requires an element ref`);
			}
			return ["get", property, ...(target ? [nativeRef(target)] : [])];
		}
		case "wait":
			return nativeWaitArguments(args);
		case "frame": {
			const target = stringValue(args.target, "frame target is required");
			return ["frame", target === "main" ? target : nativeRef(target)];
		}
		case "dialog": {
			const operation = stringValue(args.operation, "dialog operation is required").toLowerCase();
			if (!["accept", "dismiss", "status"].includes(operation)) {
				throw runtimeError("INVALID_ARGUMENT", "dialog operation must be accept, dismiss, or status");
			}
			const text = optionalStringValue(args.text);
			return ["dialog", operation, ...(text ? [text] : [])];
		}
		case "console":
		case "errors":
			return [action];
		default:
			throw runtimeError("INVALID_ARGUMENT", `Unsupported native browser action: ${action}`);
	}
}

function nativeWaitArguments(args: Record<string, unknown>): string[] {
	const timeout = String(numberValue(args.timeoutMs, 10_000, 1, 55_000));
	if (typeof args.text === "string" && args.text) return ["wait", "--text", args.text, "--timeout", timeout];
	if (typeof args.textGone === "string" && args.textGone) {
		return ["wait", `text=${args.textGone}`, "--state", "hidden", "--timeout", timeout];
	}
	if (typeof args.selector === "string" && args.selector) {
		return ["wait", args.selector, "--timeout", timeout];
	}
	if (typeof args.selectorGone === "string" && args.selectorGone) {
		return ["wait", args.selectorGone, "--state", "detached", "--timeout", timeout];
	}
	if (typeof args.url === "string" && args.url) return ["wait", "--url", `**${args.url}**`, "--timeout", timeout];
	if (args.load === true) return ["wait", "--load", "load", "--timeout", timeout];
	if (typeof args.stableMs === "number" && args.stableMs > 0) {
		const stableMs = numberValue(args.stableMs, 500, 1, 60_000);
		const expression = `(() => { const key = "__aoDomStability"; const now = performance.now(); let state = globalThis[key]; if (!state) { state = { lastMutation: now }; state.observer = new MutationObserver(() => { state.lastMutation = performance.now(); }); state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); globalThis[key] = state; } if (performance.now() - state.lastMutation < ${stableMs}) return false; state.observer.disconnect(); delete globalThis[key]; return true; })()`;
		return ["wait", "--fn", expression, "--timeout", timeout];
	}
	if (typeof args.ms === "number" && args.ms > 0) return ["wait", String(args.ms)];
	throw runtimeError("INVALID_ARGUMENT", "A wait condition is required");
}

function parseAgentBrowserJSON(stdout: string): AgentBrowserJSONResult {
	let envelope: unknown;
	try {
		envelope = JSON.parse(stdout);
	} catch {
		throw runtimeError("AGENT_BROWSER_INVALID_OUTPUT", "Browser automation returned invalid structured output");
	}
	if (!isRecord(envelope)) throw runtimeError("AGENT_BROWSER_INVALID_OUTPUT", "Browser automation returned invalid output");
	if (envelope.success === false) {
		throw runtimeError("AGENT_BROWSER_COMMAND_FAILED", stringError(envelope.error) || "Browser automation failed");
	}
	const data = envelope.data;
	if (isRecord(data)) return { ...data, untrustedExternalContent: true };
	return { value: data, untrustedExternalContent: true };
}

function nativeRef(value: string): string {
	return /^@?e\d+$/i.test(value) ? `@${value.replace(/^@/, "")}` : value;
}

function stringValue(value: unknown, message: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw runtimeError("INVALID_ARGUMENT", message);
	return allowEmpty ? value : value.trim();
}

function optionalStringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown, fallback: number, minimum: number, maximum: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw runtimeError("INVALID_ARGUMENT", `Numeric argument must be between ${minimum} and ${maximum}`);
	}
	return Math.round(value);
}

function httpURL(value: string): string {
	assertHTTPURL(value);
	return value;
}

function pngDimensions(image: Buffer): { width: number; height: number } {
	if (image.length < 24 || image.toString("ascii", 1, 4) !== "PNG") {
		throw runtimeError("AGENT_BROWSER_INVALID_OUTPUT", "Browser automation returned an invalid PNG screenshot");
	}
	return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

function stringError(value: unknown): string {
	if (typeof value === "string") return value;
	if (isRecord(value) && typeof value.message === "string") return value.message;
	return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
