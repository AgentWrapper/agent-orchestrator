import net from "node:net";

const PROTOCOL_VERSION = 1;
const BACKOFF_INIT_MS = 200;
const BACKOFF_MAX_MS = 2_000;
const MAX_COMMAND_BYTES = 1 << 20;

export type BrowserRuntimeCommand = {
	type: "command";
	requestId: string;
	sessionId: string;
	action: string;
	args?: Record<string, unknown>;
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
	execute: (command: BrowserRuntimeCommand) => Promise<unknown>;
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
	let commandChain = Promise.resolve();

	const clearRetry = () => {
		if (retryTimer !== null) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
	};

	const destroySocket = () => {
		if (!socket) return;
		socket.removeAllListeners();
		socket.destroy();
		socket = null;
	};

	const send = (message: unknown) => {
		if (!socket || socket.destroyed) return;
		socket.write(`${JSON.stringify(message)}\n`);
	};

	const respond = async (command: BrowserRuntimeCommand) => {
		try {
			const result = await options.execute(command);
			send({ type: "result", requestId: command.requestId, ok: true, result });
		} catch (error) {
			const normalized = normalizeCommandError(error);
			send({ type: "result", requestId: command.requestId, ok: false, error: normalized });
		}
	};

	const consumeLine = (line: string) => {
		if (!line.trim()) return;
		let command: BrowserRuntimeCommand;
		try {
			command = JSON.parse(line) as BrowserRuntimeCommand;
		} catch {
			return;
		}
		if (
			command.type !== "command" ||
			typeof command.requestId !== "string" ||
			typeof command.sessionId !== "string" ||
			typeof command.action !== "string"
		) {
			return;
		}
		commandChain = commandChain.then(() => respond(command));
	};

	const consume = (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		if (Buffer.byteLength(buffer, "utf8") > MAX_COMMAND_BYTES) {
			log("browser-runtime-link: oversized command frame; reconnecting");
			socket?.destroy();
			return;
		}
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			consumeLine(line);
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
		const next = typeof address === "string" ? net.connect(address) : net.connect(address);
		socket = next;
		next.on("connect", () => {
			if (disposed) {
				next.destroy();
				return;
			}
			connected = true;
			backoff = BACKOFF_INIT_MS;
			send({ type: "hello", version: PROTOCOL_VERSION });
			log("browser-runtime-link: connected");
		});
		next.on("data", consume);
		next.on("error", (error) => log(`browser-runtime-link: error: ${error.message}`));
		next.on("close", () => {
			connected = false;
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
