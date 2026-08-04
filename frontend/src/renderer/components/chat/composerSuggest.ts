/**
 * The composer's suggestion logic, kept out of the component.
 *
 * Everything here is a pure function of (text, caret) plus the candidate lists, so
 * the parts that are easy to get wrong — where a trigger starts, what a selection
 * replaces, where the caret lands — are testable without a DOM or a provider.
 *
 * Why a textarea and an anchored popup rather than a rich contenteditable editor:
 * both things AO inserts are plain text the agent has to resolve for itself (a
 * skill name and a worktree-relative path). Neither needs a non-text node in the
 * document, so the only thing a contenteditable buys is chips-in-the-flow — a
 * presentation change paid for with IME composition handling, paste sanitization,
 * an undo stack AO would own, and a11y semantics a textarea gets for free. The
 * existing keyboard contract (Enter sends, Shift+Enter newlines) is load-bearing
 * and already correct on a textarea; re-implementing it on a contenteditable is
 * risk with no user-visible gain.
 */

import type { ChatSkill } from "../../types/conversation";

/** What kind of thing the caret is currently completing. */
export type TriggerKind = "skill" | "file";

/**
 * An in-progress trigger the caret sits inside.
 *
 * `start` is the index of the trigger character itself, so a replacement can
 * overwrite the sigil along with the query.
 */
export interface ActiveTrigger {
	kind: TriggerKind;
	/** Index of the `/` or `@`. */
	start: number;
	/** Text typed after the sigil, up to the caret. */
	query: string;
}

/**
 * Characters that end a trigger. A query cannot contain whitespace: once the user
 * types a space they have moved on to prose, and holding the menu open would make
 * the next Enter select a skill instead of sending the message.
 */
const TRIGGER_BOUNDARY = /\s/;

/**
 * Find the trigger the caret is inside, if any.
 *
 * A sigil only counts at the start of the text or after whitespace. Without that
 * rule an email address or a path like `src/app` would open a menu mid-word, and
 * `and/or` would hijack Enter.
 *
 * `/` additionally only counts at the very start of the message. A slash command
 * is the whole instruction, not something dropped into a sentence — and prose is
 * full of slashes.
 */
export function findActiveTrigger(text: string, caret: number): ActiveTrigger | undefined {
	for (let i = caret - 1; i >= 0; i -= 1) {
		const char = text[i]!;
		if (TRIGGER_BOUNDARY.test(char)) return undefined;
		if (char !== "/" && char !== "@") continue;

		const preceding = i > 0 ? text[i - 1]! : undefined;
		const atBoundary = preceding === undefined || TRIGGER_BOUNDARY.test(preceding);
		if (!atBoundary) return undefined;

		if (char === "/") {
			// Anchored to the start of the message, ignoring leading whitespace.
			if (text.slice(0, i).trim() !== "") return undefined;
			return { kind: "skill", start: i, query: text.slice(i + 1, caret) };
		}
		return { kind: "file", start: i, query: text.slice(i + 1, caret) };
	}
	return undefined;
}

/**
 * Score a candidate against a query. Lower is better; `null` means no match.
 *
 * The bands (prefix, word boundary, substring) are what make the ordering feel
 * intentional rather than alphabetical: typing "rev" should put `review` above
 * `code-review`, and both above something that only mentions review in its
 * description.
 */
function score(value: string, query: string, base: number): number | null {
	const haystack = value.toLowerCase();
	if (query === "") return base;
	if (haystack === query) return base;
	if (haystack.startsWith(query)) return base + 1;

	// A match after a separator reads as the start of a word to a person.
	for (const marker of ["-", "_", "/", ":", "."]) {
		if (haystack.includes(marker + query)) return base + 2;
	}
	const at = haystack.indexOf(query);
	if (at >= 0) return base + 3 + Math.min(at, 20) / 100;
	return null;
}

/** One row in the suggestion menu. */
export interface Suggestion {
	/** Stable key, and the value a selection inserts. */
	value: string;
	/** The label shown. */
	label: string;
	/** Secondary line, when there is something worth saying. */
	detail?: string;
	/** Right-aligned provenance, e.g. a skill's scope. */
	badge?: string;
}

/**
 * How many ranked rows the menu will hold.
 *
 * Set well above what fits so the panel's own scrollbar is what tells the user
 * there is more: a hard cap at the visible row count showed 8 of 99 installed
 * skills with nothing to suggest the rest existed. The cap is still there to stop a
 * five-thousand-file worktree from rendering itself into the menu.
 */
export const MAX_SUGGESTIONS = 50;

/**
 * Rank skills for a `/` query.
 *
 * Matching runs over the invocable name, the label, and the description — a user
 * who remembers what a skill does but not what it is called still finds it — but
 * a name match always outranks a description match.
 */
export function rankSkills(skills: readonly ChatSkill[], query: string): Suggestion[] {
	const needle = query.trim().toLowerCase();
	const scored: { suggestion: Suggestion; score: number; name: string }[] = [];

	for (const skill of skills) {
		if (!skill.name) continue;
		const candidates = [
			score(skill.name, needle, 0),
			score(skill.displayName || skill.name, needle, 10),
			// Only searched when the user typed something; an empty query must not be
			// ranked by description text.
			needle === "" ? null : score(skill.description ?? "", needle, 40),
			needle === "" ? null : score(skill.inputHint ?? "", needle, 50),
		].filter((value): value is number => value !== null);
		if (candidates.length === 0) continue;

		scored.push({
			score: Math.min(...candidates),
			name: skill.name,
			suggestion: {
				value: skill.name,
				label: skill.displayName || skill.name,
				detail: skillDetail(skill),
				badge: skill.source,
			},
		});
	}

	// Name is the tie-break so the order is stable across renders: two skills with
	// the same score must not swap places as the list is refetched.
	scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
	return scored.slice(0, MAX_SUGGESTIONS).map((entry) => entry.suggestion);
}

function skillDetail(skill: ChatSkill): string | undefined {
	const description = firstLine(skill.description);
	const hint = firstLine(skill.inputHint);
	if (description && hint) return `${description} · ${hint}`;
	return description || hint;
}

/**
 * Rank worktree paths for an `@` query.
 *
 * The basename is scored ahead of the full path: people search for `ChatComposer`,
 * not for the directories above it. The full path is still matched so a directory
 * fragment narrows the list.
 */
export function rankFiles(paths: readonly string[], query: string): Suggestion[] {
	const needle = query.trim().toLowerCase();
	const scored: { suggestion: Suggestion; score: number; path: string }[] = [];

	for (const path of paths) {
		if (!path) continue;
		// Split explicitly rather than with slice(lastIndexOf(...)): a file at the repo
		// root has no slash, and the negative index silently truncates its own name
		// into a parent directory that does not exist.
		const slash = path.lastIndexOf("/");
		const base = slash < 0 ? path : path.slice(slash + 1);
		const parent = slash < 0 ? "" : path.slice(0, slash);

		const candidates = [score(base, needle, 0), score(path, needle, 10)].filter(
			(value): value is number => value !== null,
		);
		if (candidates.length === 0) continue;

		scored.push({
			score: Math.min(...candidates),
			path,
			// The row reads as "name, then where it lives", but the value inserted is
			// always the whole path — the label is never what the agent resolves.
			suggestion: { value: path, label: base, detail: parent || undefined },
		});
	}

	// Shorter paths first among equals: a file at the repo root is more often what
	// was meant than one buried six directories deep.
	scored.sort(
		(a, b) =>
			a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path),
	);
	return scored.slice(0, MAX_SUGGESTIONS).map((entry) => entry.suggestion);
}

function firstLine(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const line = text.split("\n", 1)[0]!.trim();
	return line === "" ? undefined : line;
}

/** The result of accepting a suggestion: new text and where the caret goes. */
export interface Insertion {
	text: string;
	caret: number;
}

/**
 * Replace an active trigger with the chosen value.
 *
 * A trailing space is added because the trigger is finished: without it the menu
 * would reopen on the text just inserted, and the next keystroke would filter a
 * list the user is done with.
 *
 * The sigil is kept for a skill (`/review`) and dropped for a file (a bare path),
 * because that is what each side has to resolve: Codex reads a leading slash as a
 * skill invocation, while a path only resolves if nothing is prefixed to it.
 */
export function applySuggestion(
	text: string,
	trigger: ActiveTrigger,
	value: string,
): Insertion {
	const caret = trigger.start + 1 + trigger.query.length;
	const inserted = trigger.kind === "skill" ? `/${value} ` : `${quotePath(value)} `;
	const next = text.slice(0, trigger.start) + inserted + text.slice(caret);
	return { text: next, caret: trigger.start + inserted.length };
}

/**
 * Quote a path that contains whitespace.
 *
 * An unquoted `my notes/todo.md` reads as two arguments to anything that splits on
 * spaces, which is most of what an agent does with a path.
 */
function quotePath(path: string): string {
	return /\s/.test(path) ? `"${path}"` : path;
}

/**
 * Move the highlighted row, wrapping at both ends.
 *
 * Wrapping matters for a short list reached by keyboard: pressing Up on the first
 * row should reach the last one rather than doing nothing.
 */
export function moveHighlight(current: number, delta: number, count: number): number {
	if (count === 0) return 0;
	return (current + delta + count) % count;
}
