/**
 * Terminal control sequences, made readable.
 *
 * Command output reaches the chat surface as raw bytes off a PTY: nothing in the
 * daemon strips escape sequences, so a `go test` run arrives carrying colour codes,
 * cursor moves and progress-bar carriage returns. Rendered verbatim in a `pre` those
 * are not invisible — they show up as `[0m`, `[@p`, and every redraw of a spinner
 * stacked as its own line.
 *
 * This is a text pass, not a terminal. `xterm` is already a dependency and mounting
 * one per row is what it would take to be faithful, but these rows live in a list
 * that re-renders on a one-second poll, and a terminal emulator per collapsed
 * command is orders of magnitude more than the output is worth. So the sequences are
 * removed and the two that carry meaning for a reader — carriage return and
 * backspace — are applied rather than dropped, which is what turns 200 redraws of a
 * download bar back into the one line the user would have seen.
 *
 * Colour is discarded rather than translated. Keeping it would mean emitting a span
 * per SGR run into exactly the rows that must stay cheap, and the information a
 * reader needs from a build log survives without it.
 */

/**
 * One escape sequence.
 *
 * The alternatives are ordered, not interchangeable: `[` and `]` are themselves
 * members of the single-character escape class, so CSI and OSC have to be tried
 * before it or `\x1b[31m` would lose its escape and print `[31m`.
 *
 *   CSI   `\x1b[` params intermediates final — colour, cursor moves, erases.
 *         The final byte is the full `@-~` range on purpose: the widely copied
 *         ansi-regex omits `@`, and `\x1b[@` (insert character) is precisely what
 *         codex was observed emitting.
 *   OSC   `\x1b]` … BEL or ST — window titles, hyperlinks.
 *   DCS   `\x1bP` / SOS / PM / APC … ST — device control strings.
 *   Fe    `\x1b` + one byte — `\x1bM` (reverse index) and friends.
 *   nF    `\x1b` intermediates + final — `\x1b(B` (select charset).
 *
 * Every multi-byte form also accepts end-of-string as a terminator. Output arrives in
 * deltas that can be cut mid-sequence, and a half-arrived `\x1b[3` must not show up
 * as `[3` for the second before the rest of it lands.
 */
const ESCAPE =
	/\x1B(?:\[[0-?]*[ -/]*(?:[@-~]|$)|\][\s\S]*?(?:\x07|\x1B\\|$)|[P^_X][\s\S]*?(?:\x1B\\|\x07|$)|[@-Z\\-_]|[ -/]+[0-~])/g;

/** C0 controls with no reading left after the overwrite pass. Tab and newline stay. */
const LEFTOVER_CONTROLS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Output with its control sequences resolved.
 *
 * The fast path matters more than the slow one: most rows hold plain text, and a
 * conversation re-renders on a timer, so text with nothing to strip is returned
 * unchanged without allocating.
 */
export function stripAnsi(text: string): string {
	if (text === "") return text;
	if (
		text.indexOf("\x1B") < 0 &&
		text.indexOf("\r") < 0 &&
		text.indexOf("\b") < 0 &&
		text.indexOf("\x07") < 0
	) {
		return text;
	}
	const withoutEscapes = text.replace(ESCAPE, "");
	if (withoutEscapes.indexOf("\r") < 0 && withoutEscapes.indexOf("\b") < 0) {
		return withoutEscapes.replace(LEFTOVER_CONTROLS, "");
	}
	return withoutEscapes
		.split("\n")
		.map(overwrite)
		.join("\n")
		.replace(LEFTOVER_CONTROLS, "");
}

/**
 * One line as a terminal would leave it.
 *
 * A carriage return returns to column zero and what follows overwrites in place —
 * it does not clear the line. That is why a progress bar's final frame can end with
 * the tail of a longer earlier frame still visible, and reproducing that is more
 * honest than truncating to the last write.
 */
function overwrite(line: string): string {
	if (line.indexOf("\r") < 0 && line.indexOf("\b") < 0) return line;
	let out = "";
	let column = 0;
	for (const character of line) {
		if (character === "\r") {
			column = 0;
			continue;
		}
		if (character === "\b") {
			column = Math.max(0, column - 1);
			continue;
		}
		out =
			column < out.length
				? out.slice(0, column) + character + out.slice(column + 1)
				: out + character;
		column += 1;
	}
	return out;
}

/**
 * Control characters spelled the way a terminal spells them: `^C`, `^M`, `^[`.
 *
 * For what the agent typed INTO a running command, not for what the command printed.
 * There the control character is the entire content — an abort is one `\x03` byte —
 * so stripping it would leave an empty row where the interesting thing happened.
 * Newlines are kept literal, since a multi-line paste reads as lines rather than as
 * a run of `^J`.
 */
export function caretNotation(text: string): string {
	let out = "";
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		if (character === "\n" || character === "\t") {
			out += character;
			continue;
		}
		if (code < 0x20) {
			out += `^${String.fromCharCode(code + 64)}`;
			continue;
		}
		out += code === 0x7f ? "^?" : character;
	}
	return out;
}
