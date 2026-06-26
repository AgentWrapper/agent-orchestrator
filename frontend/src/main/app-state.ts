import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The marker the desktop app writes under ~/.ao on every launch (spec §5).
 * It is the fast-path hint `ao start` reads to locate the installed bundle.
 * The Go reader is backend/internal/cli/start.go `appState`; the JSON keys
 * below MUST match its struct tags exactly (camelCase).
 */
export interface AppStateMarker {
	schemaVersion: number;
	appPath: string;
	version: string;
	installedAt: string;
	lastReconciledAt: string;
	installSource: string;
}

/** Current marker format version (spec §5, schemaVersion field). */
const SCHEMA_VERSION = 1;

/** File name of the marker under the ~/.ao state dir. */
export const APP_STATE_FILE_NAME = "app-state.json";

export interface WriteAppStateOptions {
	/** Directory the marker lives in (dirname of running.json, i.e. ~/.ao). */
	stateDir: string;
	/** Bundle path as of this launch (the macOS .app, or the platform exe). */
	appPath: string;
	/** app.getVersion(). */
	version: string;
	/**
	 * How the app was installed, captured ONLY on first marker creation from
	 * `ao start`'s --installed-via arg. Subsequent launches preserve the value
	 * already on disk. Defaults to "unknown" when absent on first creation.
	 */
	installedVia?: string;
	/** Injectable clock so tests can assert deterministic timestamps. */
	now: () => Date;
}

/**
 * Read a marker already on disk, tolerating a missing/garbage file. Returns
 * null when the file is absent or unparseable so the caller treats this as a
 * first creation (self-healing, spec §5 "self-healing a stale/missing marker").
 */
async function readExisting(file: string): Promise<AppStateMarker | null> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return null;
	}
	try {
		return JSON.parse(raw) as AppStateMarker;
	} catch {
		return null;
	}
}

/**
 * Write ~/.ao/app-state.json. The app is the SOLE writer (invariant 3) and
 * writes on every launch. Mirrors the daemon's proven atomic write
 * (backend/internal/runfile/runfile.go Write): a temp file in the same dir
 * then an atomic rename, so a concurrent `ao start` reader never observes a
 * partial file.
 *
 * On first creation, installedAt and installSource are captured and then
 * preserved across all later launches; appPath, version, and lastReconciledAt
 * are refreshed every launch (spec §5 field table).
 */
export async function writeAppStateMarker(opts: WriteAppStateOptions): Promise<void> {
	// 0o750: owner rwx, group r-x, world none — matches runfile.Write's dir mode.
	await mkdir(opts.stateDir, { recursive: true, mode: 0o750 });

	const file = path.join(opts.stateDir, APP_STATE_FILE_NAME);
	const existing = await readExisting(file);
	const nowIso = opts.now().toISOString();

	const marker: AppStateMarker = {
		schemaVersion: SCHEMA_VERSION,
		appPath: opts.appPath,
		version: opts.version,
		// Set once on first creation; preserve thereafter.
		installedAt: existing?.installedAt ?? nowIso,
		// Refreshed on every launch that touches the marker.
		lastReconciledAt: nowIso,
		installSource: existing?.installSource ?? opts.installedVia ?? "unknown",
	};

	// Pretty-print + trailing newline to match runfile.Write's MarshalIndent style.
	const data = `${JSON.stringify(marker, null, 2)}\n`;

	// Temp file in the SAME dir so the rename is atomic (same filesystem). The
	// random suffix avoids a collision if two launches race.
	const tmp = path.join(opts.stateDir, `.app-state-${process.pid}-${Date.now()}.json`);
	await writeFile(tmp, data, { mode: 0o600 });
	await rename(tmp, file);
}
