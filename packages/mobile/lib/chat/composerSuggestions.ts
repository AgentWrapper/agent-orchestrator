export type ComposerSuggestion = { kind: "skills" | "files"; query: string; start: number; end: number };

/** Find the slash/@ token immediately before the cursor, never a URL/path middle. */
export function findComposerSuggestion(text: string, cursor = text.length): ComposerSuggestion | undefined {
	const prefix = text.slice(0, Math.max(0, Math.min(cursor, text.length)));
	const skill = /(^|\s)\/([^\s/@]*)$/.exec(prefix);
	const file = /(^|\s)@([^\s@]*)$/.exec(prefix);
	const match = skill ?? file;
	if (!match) return undefined;
	const tokenStart = prefix.length - 1 - match[2].length;
	return { kind: skill ? "skills" : "files", query: match[2], start: tokenStart, end: prefix.length };
}

export function replaceComposerSuggestion(text: string, trigger: ComposerSuggestion, value: string): string {
	const sigil = trigger.kind === "skills" ? "/" : "@";
	const suffix = text.slice(trigger.end);
	return `${text.slice(0, trigger.start)}${sigil}${value}${suffix && /^\s/.test(suffix) ? "" : " "}${suffix}`;
}
