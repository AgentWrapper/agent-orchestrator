/**
 * Terminal control sequences projected into readable text for AO's desktop and
 * mobile Chat timelines. This deliberately is not a terminal emulator: colour
 * is discarded, while carriage-return and backspace overwrites are applied so
 * progress output resembles the final line a terminal displayed.
 */

// Multi-byte escape forms precede the one-character form so CSI/OSC prefixes
// are consumed as a unit. End-of-string is accepted because streamed chunks can
// end halfway through a control sequence.
const ESCAPE =
	/\x1B(?:\[[0-?]*[ -/]*(?:[@-~]|$)|\][\s\S]*?(?:\x07|\x1B\\|$)|[P^_X][\s\S]*?(?:\x1B\\|\x07|$)|[@-Z\\-_]|[ -/]+[0-~])/g;
const LEFTOVER_CONTROLS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function stripAnsi(text: string): string {
	if (
		text === "" ||
		(text.indexOf("\x1B") < 0 && text.indexOf("\r") < 0 && text.indexOf("\b") < 0 && text.indexOf("\x07") < 0)
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

function overwrite(line: string): string {
	if (line.indexOf("\r") < 0 && line.indexOf("\b") < 0) return line;
	let output = "";
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
		output =
			column < output.length
				? output.slice(0, column) + character + output.slice(column + 1)
				: output + character;
		column += 1;
	}
	return output;
}

/** Control characters spelled as a terminal displays input: ^C, ^M, ^[, etc. */
export function caretNotation(text: string): string {
	let output = "";
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		if (character === "\n" || character === "\t") {
			output += character;
		} else if (code < 0x20) {
			output += `^${String.fromCharCode(code + 64)}`;
		} else {
			output += code === 0x7f ? "^?" : character;
		}
	}
	return output;
}
