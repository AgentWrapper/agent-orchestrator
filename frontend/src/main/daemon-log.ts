import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export const DAEMON_LOG_FILE_NAME = "daemon.log";
export const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024;

type DaemonOutputStream = "stdout" | "stderr";

export function daemonLogPath(runFilePath: string | null, homeDir: string): string | null {
	const stateDir = runFilePath ? path.dirname(runFilePath) : homeDir ? path.join(homeDir, ".ao") : null;
	if (!stateDir) return null;
	return path.join(stateDir, "logs", DAEMON_LOG_FILE_NAME);
}

export class DaemonLogSink {
	readonly path: string;
	private readonly stream: WriteStream;
	private readonly pending: Record<DaemonOutputStream, string> = { stdout: "", stderr: "" };
	private closed = false;

	constructor(filePath: string, stream: WriteStream) {
		this.path = filePath;
		this.stream = stream;
	}

	writeMeta(message: string): void {
		this.stream.write(`${new Date().toISOString()} [supervisor] ${message}\n`);
	}

	writeOutput(source: DaemonOutputStream, chunk: string): void {
		const combined = this.pending[source] + chunk.replace(/\r\n/g, "\n");
		const lines = combined.split("\n");
		this.pending[source] = lines.pop() ?? "";
		for (const line of lines) {
			this.writeOutputLine(source, line);
		}
	}

	close(): Promise<void> {
		if (this.closed) return Promise.resolve();
		this.closed = true;
		for (const source of ["stdout", "stderr"] as const) {
			const pending = this.pending[source];
			if (pending) {
				this.writeOutputLine(source, pending);
				this.pending[source] = "";
			}
		}
		return new Promise((resolve) => {
			this.stream.end(resolve);
		});
	}

	private writeOutputLine(source: DaemonOutputStream, line: string): void {
		this.stream.write(`${new Date().toISOString()} [${source}] ${line}\n`);
	}
}

export async function openDaemonLog(runFilePath: string | null, homeDir: string): Promise<DaemonLogSink | null> {
	const filePath = daemonLogPath(runFilePath, homeDir);
	if (!filePath) return null;
	await mkdir(path.dirname(filePath), { recursive: true });
	await rotateDaemonLogIfNeeded(filePath);
	const stream = createWriteStream(filePath, { flags: "a" });
	stream.on("error", () => undefined);
	const sink = new DaemonLogSink(filePath, stream);
	sink.writeMeta("daemon launch output started");
	return sink;
}

async function rotateDaemonLogIfNeeded(filePath: string): Promise<void> {
	try {
		const info = await stat(filePath);
		if (info.size <= DAEMON_LOG_MAX_BYTES) return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const rotated = `${filePath}.1`;
	await rm(rotated, { force: true });
	await rename(filePath, rotated);
}
