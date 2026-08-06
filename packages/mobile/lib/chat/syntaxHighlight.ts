export type SyntaxTokenKind = "plain" | "comment" | "string" | "number" | "keyword" | "type" | "addition" | "deletion" | "meta";
export type SyntaxToken = { text: string; kind: SyntaxTokenKind };

const LANGUAGE_ALIASES: Record<string, string> = {
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	ts: "typescript", tsx: "typescript",
	py: "python", rs: "rust", sh: "shell", bash: "shell", zsh: "shell",
	yml: "yaml", html: "markup", xml: "markup", md: "markdown",
};

const KEYWORDS: Record<string, Set<string>> = {
	javascript: words("as async await break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof interface let new of package private protected public return set static super switch throw try type typeof undefined var void while with yield"),
	typescript: words("as async await break case catch class const continue declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface keyof let namespace never new of private protected public readonly return satisfies set static super switch throw try type typeof undefined unknown var void while yield"),
	go: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
	python: words("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield"),
	rust: words("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while"),
	shell: words("case do done elif else esac export fi for function if in local readonly return set then unset while"),
	sql: words("alter and as asc begin by case commit create delete desc distinct drop else end exists from group having in index insert into is join left like limit not null on or order outer primary references right rollback select set table then union unique update values view when where"),
	css: words("important inherit initial revert unset var calc media supports keyframes from to"),
	yaml: words("true false null yes no on off"),
	json: words("true false null"),
};

const SUPPORTED = new Set([...Object.keys(KEYWORDS), "diff", "markup", "markdown"]);

/** Lightweight native tokenization. Unknown grammars stay exact plain text. */
export function highlightCode(code: string, rawLanguage?: string): SyntaxToken[] | undefined {
	if (!rawLanguage) return undefined;
	const lowered = rawLanguage.trim().toLowerCase().replace(/^language-/, "");
	const language = LANGUAGE_ALIASES[lowered] ?? lowered;
	if (!SUPPORTED.has(language)) return undefined;
	if (language === "diff") return diffTokens(code);

	const comment = ["python", "shell", "yaml"].includes(language)
		? "#[^\\n]*"
		: language === "sql"
			? "--[^\\n]*|/\\*[\\s\\S]*?\\*/"
			: language === "markup"
				? "<!--[\\s\\S]*?-->"
				: "//[^\\n]*|/\\*[\\s\\S]*?\\*/";
	const stringLiteral = "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|\\x60(?:\\\\.|[^\\x60\\\\])*\\x60";
	const source = new RegExp(`(${comment})|(${stringLiteral})|(\\b(?:0x[\\da-f]+|\\d+(?:\\.\\d+)?)\\b)|(\\b[A-Za-z_$][\\w$]*\\b)`, "gis");
	const keywords = KEYWORDS[language] ?? new Set<string>();
	const tokens: SyntaxToken[] = [];
	let at = 0;
	let match: RegExpExecArray | null;
	while ((match = source.exec(code))) {
		if (match.index > at) tokens.push({ text: code.slice(at, match.index), kind: "plain" });
		const text = match[0];
		const kind: SyntaxTokenKind = match[1]
			? "comment"
			: match[2]
				? "string"
				: match[3]
					? "number"
					: keywords.has(text.toLowerCase())
						? "keyword"
						: /^[A-Z]/.test(text) ? "type" : "plain";
		tokens.push({ text, kind });
		at = source.lastIndex;
	}
	if (at < code.length) tokens.push({ text: code.slice(at), kind: "plain" });
	return tokens;
}

function diffTokens(code: string): SyntaxToken[] {
	return code.split(/(?<=\n)/).map((line) => ({
		text: line,
		kind: line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff ")
			? "meta"
			: line.startsWith("+") ? "addition" : line.startsWith("-") ? "deletion" : "plain",
	}));
}

function words(value: string): Set<string> {
	return new Set(value.split(" "));
}
