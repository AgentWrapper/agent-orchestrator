import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DROP_RETENTION_MS = 24 * 60 * 60 * 1000;

export async function saveDroppedFile(
	dir: string,
	input: { name: string; bytes: Uint8Array },
	now: number,
): Promise<string> {
	if (!input || typeof input.name !== "string" || !(input.bytes instanceof Uint8Array)) {
		throw new Error("saveDroppedFile: expected { name: string, bytes: Uint8Array }");
	}

	await mkdir(dir, { recursive: true });

	const entries = await readdir(dir).catch(() => [] as string[]);
	await Promise.all(
		entries.map(async (entry) => {
			const stale = path.join(dir, entry);
			try {
				const info = await stat(stale);
				if (now - info.mtimeMs > DROP_RETENTION_MS) await rm(stale, { force: true });
			} catch {
				return;
			}
		}),
	);

	const base = path.basename(input.name).replace(/[^\w.-]+/g, "_") || "dropped";
	const target = path.join(dir, `${now}-${randomUUID()}-${base}`);
	await writeFile(target, Buffer.from(input.bytes));
	return target;
}
