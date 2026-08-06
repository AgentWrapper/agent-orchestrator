// Keys a phone keyboard lacks — sent straight to the PTY as escape sequences.
//
// These cannot go through the REST `/sessions/{id}/send` route: the daemon runs
// SanitizeControlChars on that payload (backend/internal/domain/text.go), which
// strips every one of them. The mux is the only path for control bytes.
//
// Exactly eight, and the row divides its width between them — see KeyRow.
export type ControlKey = { label: string; seq: string; hint: string };

export const CONTROL_KEYS: ControlKey[] = [
	{ label: "esc", seq: "\x1b", hint: "Escape" },
	{ label: "tab", seq: "\t", hint: "Tab" },
	{ label: "^C", seq: "\x03", hint: "Interrupt" },
	{ label: "←", seq: "\x1b[D", hint: "Left" },
	{ label: "↑", seq: "\x1b[A", hint: "Up" },
	{ label: "↓", seq: "\x1b[B", hint: "Down" },
	{ label: "→", seq: "\x1b[C", hint: "Right" },
	{ label: "↵", seq: "\r", hint: "Enter" },
];
