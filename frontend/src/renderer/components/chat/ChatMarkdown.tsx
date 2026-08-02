/**
 * Markdown for agent prose.
 *
 * Agents write markdown — headings, lists, tables, fenced code — and rendering it
 * as preformatted text was showing the syntax instead of the structure. `## Plan`
 * appeared as literal hashes, a table as a wall of pipes, a code block bracketed by
 * visible backticks.
 *
 * Three deliberate choices about what this does NOT do:
 *
 *   - Raw HTML is escaped, not rendered. Agent output is only as trustworthy as the
 *     files it just read, so `rehype-raw` is deliberately absent; markdown-only is
 *     the whole sanitization story and there is no schema to get wrong.
 *   - No syntax highlighting yet. A fenced block gets its language label, a copy
 *     button, and a horizontal scroll of its own. Tokenizing means shipping
 *     grammars, and the block is readable without them.
 *   - Nothing here re-parses or re-orders content. It renders exactly the text the
 *     daemon stored, so the rendered form and the record cannot disagree.
 *
 * Streaming is fine unstyled-first: an unclosed fence renders as a code block with
 * partial content and settles when the closing fence arrives.
 */

import { memo, useCallback, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { cn } from "../../lib/utils";

/** GitHub-flavoured markdown: tables, strikethrough, task lists, autolinks. */
const PLUGINS = [remarkGfm];

export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
	return (
		<div className="chat-md text-sm leading-[1.58] text-foreground">
			<Markdown remarkPlugins={PLUGINS} components={COMPONENTS}>
				{text}
			</Markdown>
		</div>
	);
});

/**
 * A fenced code block: language on the left, copy on the right, its own scroll.
 *
 * The block scrolls rather than wrapping because a wrapped line of code is harder
 * to read than a scrolled one, and it must never widen the conversation column.
 */
function CodeBlock({ code, language }: { code: string; language?: string }) {
	const [copied, setCopied] = useState(false);

	const copy = useCallback(() => {
		void navigator.clipboard.writeText(code).then(
			() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1400);
			},
			() => {
				// Clipboard denied. Saying nothing is better than a false "Copied".
			},
		);
	}, [code]);

	return (
		<div className="my-2.5 overflow-hidden rounded-lg border border-border bg-surface">
			<div className="flex items-center gap-2 border-b border-border bg-raised/40 px-2.5 py-1">
				<span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
					{language || "text"}
				</span>
				<button
					type="button"
					onClick={copy}
					aria-label={copied ? "Copied" : "Copy code"}
					className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
				>
					{copied ? (
						<Check aria-hidden="true" className="size-3 text-success" />
					) : (
						<Copy aria-hidden="true" className="size-3" />
					)}
					{copied ? "Copied" : "Copy"}
				</button>
			</div>
			<pre className="overflow-x-auto px-3 py-2.5">
				<code className="font-mono text-[12px] leading-[1.6] text-foreground">{code}</code>
			</pre>
		</div>
	);
}

/** The text inside a node, for the copy button and language sniffing. */
function textOf(children: ReactNode): string {
	if (typeof children === "string") return children;
	if (typeof children === "number") return String(children);
	if (Array.isArray(children)) return children.map(textOf).join("");
	if (children && typeof children === "object" && "props" in children) {
		return textOf((children as { props?: { children?: ReactNode } }).props?.children);
	}
	return "";
}

const LANGUAGE_CLASS = /language-([\w+#-]+)/;

const COMPONENTS: Components = {
	// Headings step down in size but stay in the conversation's voice — an agent's
	// "## Findings" is a paragraph label, not a page title.
	h1: ({ children }) => (
		<h3 className="mb-1.5 mt-4 text-[15px] font-semibold leading-snug text-foreground first:mt-0">
			{children}
		</h3>
	),
	h2: ({ children }) => (
		<h4 className="mb-1.5 mt-3.5 text-[14px] font-semibold leading-snug text-foreground first:mt-0">
			{children}
		</h4>
	),
	h3: ({ children }) => (
		<h5 className="mb-1 mt-3 text-[13.5px] font-semibold leading-snug text-foreground first:mt-0">
			{children}
		</h5>
	),
	h4: ({ children }) => (
		<h6 className="mb-1 mt-3 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground first:mt-0">
			{children}
		</h6>
	),

	p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,

	ul: ({ children }) => <ul className="my-2 ml-4 list-disc space-y-1 first:mt-0">{children}</ul>,
	ol: ({ children }) => (
		<ol className="my-2 ml-4 list-decimal space-y-1 first:mt-0">{children}</ol>
	),
	li: ({ children, className }) => (
		// A task-list item drops its bullet: the checkbox is the marker.
		<li className={cn("marker:text-muted-foreground", className?.includes("task-list-item") && "list-none")}>
			{children}
		</li>
	),
	// Read-only on purpose. The checkbox reflects what the agent wrote; clicking it
	// would imply AO could change the agent's plan, which it cannot.
	input: ({ checked, type }) =>
		type === "checkbox" ? (
			<input
				type="checkbox"
				checked={Boolean(checked)}
				readOnly
				aria-label={checked ? "done" : "not done"}
				className="mr-1.5 -ml-4 size-3 translate-y-[1px] accent-accent"
			/>
		) : null,

	code: ({ className, children }) => {
		const language = LANGUAGE_CLASS.exec(className ?? "")?.[1];
		// react-markdown routes both inline code and fenced blocks here; a fence is
		// the one carrying a language class, and `pre` below unwraps the rest.
		if (language) return <CodeBlock code={textOf(children).replace(/\n$/, "")} language={language} />;
		return (
			<code className="rounded bg-surface px-[5px] py-[2px] font-mono text-[11.5px] text-accent">
				{children}
			</code>
		);
	},
	// A fenced block already rendered itself through `code`; `pre` would otherwise
	// wrap it in a second box.
	pre: ({ children }) => <>{children}</>,

	// Wide tables scroll inside their own container so the conversation column
	// never scrolls sideways.
	table: ({ children }) => (
		<div className="my-2.5 overflow-x-auto rounded-lg border border-border">
			<table className="w-full border-collapse text-[12.5px]">{children}</table>
		</div>
	),
	thead: ({ children }) => <thead className="bg-raised/40">{children}</thead>,
	th: ({ children }) => (
		<th className="border-b border-border px-2.5 py-1.5 text-left font-medium text-muted-foreground">
			{children}
		</th>
	),
	td: ({ children }) => (
		<td className="border-b border-border/60 px-2.5 py-1.5 align-top">{children}</td>
	),

	blockquote: ({ children }) => (
		<blockquote className="my-2.5 border-l-2 border-border-strong pl-3 text-muted-foreground">
			{children}
		</blockquote>
	),
	hr: () => <hr className="my-3 border-border" />,
	strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
	del: ({ children }) => <del className="text-muted-foreground">{children}</del>,

	// Links open in the user's browser, not inside the app: a chat surface is not a
	// web view, and navigating the renderer away would lose the session.
	a: ({ href, children }) => (
		<a
			href={href}
			target="_blank"
			rel="noreferrer noopener"
			className="text-accent underline decoration-accent-dim underline-offset-2 hover:decoration-accent"
		>
			{children}
		</a>
	),

	img: ({ src, alt }) => (
		<img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} className="my-2 max-w-full rounded-md border border-border" />
	),
};
