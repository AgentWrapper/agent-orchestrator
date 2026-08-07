/**
 * The grammars themselves, in a chunk of their own.
 *
 * Split out from `code-highlight.ts` so this file is the only thing behind the
 * dynamic `import()`: a conversation that is all prose never downloads a parser,
 * and the chat surface's first paint never waits on one.
 *
 * The list is what coding agents actually emit, not what highlight.js offers.
 * Adding a grammar is a bundle decision — `common` (37 languages) is roughly
 * four times this set, for languages that will not appear in an AO session.
 */

import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * Registration names here must match the values in `code-highlight.ts`'s alias
 * table; that table is the one the app consults, so a name only reachable
 * through a highlight.js-declared alias would never be asked for.
 */
export function createEngine() {
	return createLowlight({
		bash,
		css,
		diff,
		go,
		javascript,
		json,
		markdown,
		python,
		rust,
		sql,
		typescript,
		xml,
		yaml,
	});
}

export type CodeEngine = ReturnType<typeof createEngine>;
