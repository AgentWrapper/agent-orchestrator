import { caretNotation, stripAnsi } from "../../../shared/chat/ansi";

export { caretNotation, stripAnsi };

/** Compatibility read for older durable ACP rows containing structured output. */
export function commandOutputText(raw: unknown): string {
	if (typeof raw === "string") return stripAnsi(raw);
	if (!raw || typeof raw !== "object") return "";
	const value = raw as Record<string, unknown>;
	for (const key of ["output", "text", "error", "metadata"]) {
		const text = commandOutputText(value[key]);
		if (text) return text;
	}
	try {
		return JSON.stringify(raw, null, 2);
	} catch {
		return "";
	}
}
