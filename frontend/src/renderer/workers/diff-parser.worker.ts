// Runs parseUnifiedDiff (parsing + the intra-line LCS highlighting) off the
// render thread for large diffs. See useParsedDiff, which only routes here
// above a size threshold — small diffs stay on the main thread since a
// worker round-trip costs more than the parse itself for those.
//
// The project's tsconfig only loads the "DOM" lib (no "WebWorker"), since
// this is the one file in the renderer that runs in a worker context rather
// than a window — adding "WebWorker" globally would mix incompatible global
// types (self/postMessage disagree between the two libs) across every other
// file. Casting the worker's global scope through `Worker` sidesteps that
// without touching the shared tsconfig.
import { parseUnifiedDiff, type DiffRow } from "../lib/diff-parser";

export type DiffParserRequest = {
	id: number;
	diff: string;
};

export type DiffParserResponse = { id: number; ok: true; rows: DiffRow[] } | { id: number; ok: false; error: string };

const worker = self as unknown as Worker;

worker.addEventListener("message", (event: MessageEvent<DiffParserRequest>) => {
	const { id, diff } = event.data;
	try {
		const rows = parseUnifiedDiff(diff);
		const response: DiffParserResponse = { id, ok: true, rows };
		worker.postMessage(response);
	} catch (error) {
		const response: DiffParserResponse = {
			id,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
		worker.postMessage(response);
	}
});
