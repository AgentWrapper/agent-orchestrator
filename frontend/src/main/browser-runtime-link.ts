import net from "node:net";
import { StringDecoder } from "node:string_decoder";

const PROTOCOL_VERSION = 2;
const BACKOFF_INIT_MS = 200;
const BACKOFF_MAX_MS = 2_000;
const MAX_COMMAND_BYTES = 1 << 20;
const MAX_RESULT_BYTES = 8 << 20;

export type BrowserRuntimeCommand = {
	type: "command";
	requestId: string;
	sessionId: string;
	action: string;
	args?: Record<string, unknown>;
};

type BrowserRuntimeCancel = {
	type: "cancel";
	requestId: string;
};

export type BrowserRuntimeCommandError = {
	code: string;
	message: string;
};

export interface BrowserRuntimeLinkHandle {
	readonly connected: boolean;
	dispose(): void;
}

type BrowserRuntimeLinkOptions = {
	execute: (command: BrowserRuntimeCommand, signal: AbortSignal) => Promise<unknown>;
	token?: string;
	log?: (message: string) => void;
};

export function connectBrowserRuntime(
	address: string | net.TcpNetConnectOpts,
	options: BrowserRuntimeLinkOptions,
): BrowserRuntimeLinkHandle {
	const log = options.log ?? (() => undefined);
	let disposed = false;
	let connected = false;
	let socket: net.Socket | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let backoff = BACKOFF_INIT_MS;
	let buffer = "";
	let decoder = new StringDecoder("utf8");
	let connectionEpoch = 0;
	const commandChains = new Map<string, Promise<void>>();
	const commandControllers = new Map<string, AbortController>();

	const cancelConnectionCommands = () => {
		for (const controller of commandControllers.values()) controller.abort();
		commandControllers.clear();
		commandChains.clear();
	};

	const clearRetry = () => {
		if (retryTimer !== null) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
	};

	const destroySocket = () => {
		if (!socket) return;
		connectionEpoch += 1;
		cancelConnectionCommands();
		socket.removeAllListeners();
		socket.destroy();
		socket = null;
	};

	const send = async (message: unknown, target: net.Socket, epoch: number): Promise<void> => {
		if (socket !== target || connectionEpoch !== epoch || target.destroyed) return;
		const frame = `${JSON.stringify(message)}\n`;
		if (Buffer.byteLength(frame, "utf8") > MAX_RESULT_BYTES) {
			throw Object.assign(new Error(`Browser result exceeds ${MAX_RESULT_BYTES} bytes`), {
				code: "BROWSER_RESULT_TOO_LARGE",
			});
		}
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				target.off("error", onError);
				reject(error);
			};
			target.once("error", onError);
			target.write(frame, (error) => {
				target.off("error", onError);
				if (error) reject(error);
				else resolve();
			});
		});
	};

	const respond = async (
		command: BrowserRuntimeCommand,
		target: net.Socket,
		epoch: number,
		controller: AbortController,
	) => {
		try {
			controller.signal.throwIfAborted();
			const result = await options.execute(command, controller.signal);
			controller.signal.throwIfAborted();
			await send({ type: "result", requestId: command.requestId, ok: true, result }, target, epoch);
		} catch (error) {
			if (controller.signal.aborted) return;
			const normalized = normalizeCommandError(error);
			try {
				await send({ type: "result", requestId: command.requestId, ok: false, error: normalized }, target, epoch);
			} catch (sendError) {
				log(`browser-runtime-link: response failed: ${String(sendError)}`);
				target.destroy();
			}
		} finally {
			if (commandControllers.get(command.requestId) === controller) {
				commandControllers.delete(command.requestId);
			}
		}
	};

	const consumeLine = (line: string, target: net.Socket, epoch: number) => {
		if (!line.trim()) return;
		let message: BrowserRuntimeCommand | BrowserRuntimeCancel;
		try {
			message = JSON.parse(line) as BrowserRuntimeCommand | BrowserRuntimeCancel;
		} catch {
			return;
		}
		if (message.type === "cancel" && typeof message.requestId === "string") {
			commandControllers.get(message.requestId)?.abort();
			return;
		}
		const command = message as BrowserRuntimeCommand;
		if (
			command.type !== "command" ||
			typeof command.requestId !== "string" ||
			typeof command.sessionId !== "string" ||
			typeof command.action !== "string"
		) {
			return;
		}
		const controller = new AbortController();
		commandControllers.set(command.requestId, controller);
		const previous = commandChains.get(command.sessionId) ?? Promise.resolve();
		const next = previous.then(() => respond(command, target, epoch, controller));
		commandChains.set(command.sessionId, next);
		void next.finally(() => {
			if (commandChains.get(command.sessionId) === next) commandChains.delete(command.sessionId);
		});
	};

	const consume = (chunk: Buffer, target: net.Socket, epoch: number) => {
		if (socket !== target || connectionEpoch !== epoch) return;
		buffer += decoder.write(chunk);
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) {
				if (Buffer.byteLength(buffer, "utf8") > MAX_COMMAND_BYTES) {
					log("browser-runtime-link: oversized command frame; reconnecting");
					target.destroy();
				}
				return;
			}
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (Buffer.byteLength(line, "utf8") > MAX_COMMAND_BYTES) {
				log("browser-runtime-link: oversized command frame; reconnecting");
				target.destroy();
				return;
			}
			consumeLine(line, target, epoch);
		}
	};

	const scheduleReconnect = () => {
		if (disposed) return;
		clearRetry();
		const delay = backoff;
		backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
		retryTimer = setTimeout(connect, delay);
	};

	function connect() {
		if (disposed) return;
		destroySocket();
		buffer = "";
		decoder = new StringDecoder("utf8");
		const epoch = ++connectionEpoch;
		const next = typeof address === "string" ? net.connect(address) : net.connect(address);
		socket = next;
		next.on("connect", () => {
			if (disposed) {
				next.destroy();
				return;
			}
			connected = true;
			backoff = BACKOFF_INIT_MS;
			void send({ type: "hello", version: PROTOCOL_VERSION, token: options.token }, next, epoch).catch((error) => {
				log(`browser-runtime-link: hello failed: ${String(error)}`);
				next.destroy();
			});
			log("browser-runtime-link: connected");
		});
		next.on("data", (chunk) => consume(chunk, next, epoch));
		next.on("error", (error) => log(`browser-runtime-link: error: ${error.message}`));
		next.on("close", () => {
			if (socket !== next || connectionEpoch !== epoch) return;
			connected = false;
			socket = null;
			connectionEpoch += 1;
			cancelConnectionCommands();
			if (!disposed) scheduleReconnect();
		});
	}

	connect();
	return {
		get connected() {
			return connected;
		},
		dispose() {
			disposed = true;
			connected = false;
			clearRetry();
			destroySocket();
		},
	};
}

function normalizeCommandError(error: unknown): BrowserRuntimeCommandError {
	if (isCommandError(error)) {
		return { code: error.code, message: error.message };
	}
	return {
		code: "BROWSER_COMMAND_FAILED",
		message: error instanceof Error ? error.message : "Browser command failed",
	};
}

function isCommandError(error: unknown): error is BrowserRuntimeCommandError {
	return Boolean(
		error &&
		typeof error === "object" &&
		typeof (error as BrowserRuntimeCommandError).code === "string" &&
		typeof (error as BrowserRuntimeCommandError).message === "string",
	);
}
