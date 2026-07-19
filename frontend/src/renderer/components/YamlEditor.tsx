import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import {
	EditorView,
	drawSelection,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { yaml } from "@codemirror/lang-yaml";
import { cn } from "../lib/utils";

// Syntax colours keyed to the app tokens so the editor tracks light/dark with
// the rest of the renderer (refined-blue accent for keys, muted for comments).
const highlightStyle = HighlightStyle.define([
	{ tag: [tags.definition(tags.propertyName), tags.propertyName, tags.keyword], color: "var(--color-primary)" },
	{ tag: [tags.string, tags.special(tags.string)], color: "var(--color-foreground)" },
	{ tag: [tags.number, tags.bool, tags.null], color: "var(--color-text-muted)" },
	{ tag: [tags.comment, tags.lineComment], color: "var(--color-text-passive)", fontStyle: "italic" },
	{ tag: [tags.punctuation, tags.separator], color: "var(--color-text-passive)" },
]);

// Chrome matched to the surrounding surface; sizing/scroll owned by the parent.
const theme = EditorView.theme({
	"&": {
		height: "100%",
		fontSize: "12.5px",
		color: "var(--color-foreground)",
		backgroundColor: "transparent",
	},
	"&.cm-focused": { outline: "none" },
	".cm-scroller": {
		fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
		lineHeight: "1.6",
	},
	".cm-gutters": {
		backgroundColor: "transparent",
		color: "var(--color-text-passive)",
		border: "none",
	},
	".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--color-foreground) 4%, transparent)" },
	".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--color-text-muted)" },
	".cm-cursor": { borderLeftColor: "var(--color-primary)" },
	".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
		backgroundColor: "color-mix(in srgb, var(--color-primary) 25%, transparent)",
	},
	".cm-content": { caretColor: "var(--color-primary)" },
});

function extensions(readOnly: boolean) {
	return [
		lineNumbers(),
		highlightActiveLine(),
		highlightActiveLineGutter(),
		drawSelection(),
		history(),
		indentOnInput(),
		bracketMatching(),
		syntaxHighlighting(highlightStyle),
		yaml(),
		keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
		theme,
		EditorView.editable.of(!readOnly),
		EditorState.readOnly.of(readOnly),
	];
}

export type YamlEditorProps = {
	value: string;
	onChange: (value: string) => void;
	readOnly?: boolean;
	// 1-based line to scroll into view (top-aligned). The split view sets this
	// to the selected stage's block; out-of-range or null values are no-ops.
	revealLine?: number | null;
	className?: string;
	"aria-label"?: string;
};

// Thin CodeMirror 6 wrapper: builds the view once, then pushes external `value`
// changes in only when they diverge from the live doc (so typing never fights a
// re-render). `onChange` is read through a ref so the update listener stays
// stable across renders.
export function YamlEditor({ value, onChange, readOnly = false, revealLine, className, ...aria }: YamlEditorProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	useEffect(() => {
		if (!hostRef.current) return;
		const view = new EditorView({
			parent: hostRef.current,
			state: EditorState.create({
				doc: value,
				extensions: [
					...extensions(readOnly),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) onChangeRef.current(update.state.doc.toString());
					}),
				],
			}),
		});
		viewRef.current = view;
		return () => {
			view.destroy();
			viewRef.current = null;
		};
		// Rebuild only when the read-only mode flips; value sync is handled below.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [readOnly]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		const current = view.state.doc.toString();
		if (current === value) return;
		view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
	}, [value]);

	// Best-effort reveal: scroll the requested line to the top of the pane when
	// it changes (node select in split view). Never touches the selection, so it
	// cannot fight active typing.
	useEffect(() => {
		const view = viewRef.current;
		if (!view || revealLine == null) return;
		if (revealLine < 1 || revealLine > view.state.doc.lines) return;
		const pos = view.state.doc.line(revealLine).from;
		view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 8 }) });
	}, [revealLine]);

	return (
		<div
			ref={hostRef}
			className={cn("h-full min-h-0 overflow-auto", className)}
			aria-label={aria["aria-label"]}
			data-testid="yaml-editor"
		/>
	);
}
