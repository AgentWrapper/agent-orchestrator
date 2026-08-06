import { useEffect, useMemo, useState } from "react";
import { parseUnifiedDiff, type DiffRow } from "../lib/diff-parser";
import DiffParserWorker from "../workers/diff-parser.worker?worker";
import type { DiffParserRequest, DiffParserResponse } from "../workers/diff-parser.worker";

// Below this, parsing synchronously on the render thread is already
// effectively instant (a few ms at most) — routing through a worker would
// only add message-passing latency for no benefit. Above it, parsing (in
// particular the intra-line LCS highlighting) can take long enough to be
// felt as a hitch, so it moves off the render thread entirely instead.
const WORKER_DIFF_THRESHOLD_CHARS = 50_000;

let sharedWorker: Worker | null = null;
let sharedWorkerFailed = false;
let nextRequestId = 0;
const pendingRequests = new Map<number, { resolve: (rows: DiffRow[]) => void; reject: (error: Error) => void }>();

// One worker instance shared across every open diff, not one per file: this
// parser is cheap (no syntax highlighting, unlike e.g. @pierre/diffs), so a
// single worker keeps up, and it avoids paying worker-startup cost on every
// file open.
function getSharedWorker(): Worker | null {
	if (sharedWorkerFailed || typeof Worker === "undefined") return null;
	if (sharedWorker) return sharedWorker;
	try {
		const worker = new DiffParserWorker();
		worker.addEventListener("message", (event: MessageEvent<DiffParserResponse>) => {
			const entry = pendingRequests.get(event.data.id);
			if (!entry) return;
			pendingRequests.delete(event.data.id);
			if (event.data.ok) entry.resolve(event.data.rows);
			else entry.reject(new Error(event.data.error));
		});
		worker.addEventListener("error", () => {
			// A worker-level error (e.g. the script failed to load) doesn't carry a
			// request id — fail everything in flight so callers fall back to
			// parsing synchronously instead of hanging forever, and stop trying to
			// use this worker going forward.
			sharedWorkerFailed = true;
			for (const [id, entry] of pendingRequests) {
				entry.reject(new Error("diff parser worker failed"));
				pendingRequests.delete(id);
			}
		});
		sharedWorker = worker;
	} catch {
		sharedWorkerFailed = true;
	}
	return sharedWorker;
}

function parseInWorker(diff: string): Promise<DiffRow[]> {
	const worker = getSharedWorker();
	if (!worker) return Promise.reject(new Error("diff parser worker unavailable"));
	return new Promise((resolve, reject) => {
		const id = nextRequestId++;
		pendingRequests.set(id, { resolve, reject });
		const request: DiffParserRequest = { id, diff };
		worker.postMessage(request);
	});
}

export type ParsedDiffResult = {
	rows: DiffRow[];
	// True only while a large diff's worker parse is still in flight. Small
	// diffs are never pending — they resolve synchronously on the same
	// render, so callers can tell "still parsing" apart from "genuinely no
	// changes" (rows.length === 0) without an extra render's delay.
	pending: boolean;
};

// Parses `diff` into rows. Small diffs resolve synchronously on the very
// first render, byte-for-byte the same behavior as calling parseUnifiedDiff
// directly (this is the common case — the vast majority of diffs never pay
// for anything below this line). Large diffs parse in a background worker so
// the render thread never blocks on them; if the worker is unavailable or
// fails (jsdom in tests, a CSP that blocks it, etc.), parsing falls back to
// the same synchronous path rather than the diff silently never appearing.
export function useParsedDiff(diff: string): ParsedDiffResult {
	const isSmall = diff.length < WORKER_DIFF_THRESHOLD_CHARS;
	const syncRows = useMemo(() => (isSmall ? parseUnifiedDiff(diff) : null), [diff, isSmall]);
	const [asyncResult, setAsyncResult] = useState<{ diff: string; rows: DiffRow[] } | null>(null);

	useEffect(() => {
		if (isSmall) return;
		let cancelled = false;
		parseInWorker(diff)
			.catch(() => parseUnifiedDiff(diff))
			.then((rows) => {
				if (cancelled) return;
				setAsyncResult({ diff, rows });
			});
		return () => {
			cancelled = true;
		};
	}, [diff, isSmall]);

	if (isSmall) return { rows: syncRows ?? [], pending: false };
	if (asyncResult?.diff === diff) return { rows: asyncResult.rows, pending: false };
	return { rows: [], pending: true };
}
