import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const USER_FACING_ATTRIBUTES = new Set([
	"aria-label",
	"aria-description",
	"title",
	"placeholder",
	"label",
	"description",
	"subtitle",
]);
const USER_FACING_PROPERTIES = new Set([
	"ariaLabel",
	"title",
	"placeholder",
	"message",
	"error",
	"detail",
	"label",
	"description",
	"subtitle",
	"reason",
]);
const USER_MESSAGE_FUNCTION_NAME = /(?:error|message|label|title|detail|description|placeholder|reason)/i;

function normalizeText(value) {
	return value.replace(/\s+/g, " ").trim();
}

function containsEnglish(value) {
	return /[A-Za-z]{2,}/.test(value);
}

function propertyName(node) {
	if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
	return null;
}

function isTranslationCall(node) {
	if (!ts.isCallExpression(node)) return false;
	if (ts.isIdentifier(node.expression)) return node.expression.text === "t";
	return ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "t";
}

function jsxExpressionContext(node) {
	let current = node.parent;
	while (current) {
		if (isTranslationCall(current)) return null;
		if (ts.isJsxExpression(current)) return current;
		if (
			ts.isSourceFile(current) ||
			ts.isJsxAttribute(current) ||
			ts.isJsxElement(current) ||
			ts.isJsxFragment(current) ||
			ts.isJsxOpeningElement(current) ||
			ts.isJsxSelfClosingElement(current)
		) {
			return null;
		}
		current = current.parent;
	}
	return null;
}

function isRenderedExpressionValue(node, context) {
	let current = node;
	while (current.parent && current.parent !== context) {
		const parent = current.parent;
		if (ts.isParenthesizedExpression(parent)) {
			current = parent;
			continue;
		}
		if (ts.isConditionalExpression(parent)) {
			if (current === parent.condition) return false;
			current = parent;
			continue;
		}
		if (ts.isBinaryExpression(parent)) {
			const operator = parent.operatorToken.kind;
			if (operator === ts.SyntaxKind.PlusToken) {
				current = parent;
				continue;
			}
			if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
				if (current !== parent.right) return false;
				current = parent;
				continue;
			}
			if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
				current = parent;
				continue;
			}
		}
		return false;
	}
	return current.parent === context;
}

function literalText(node) {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	if (!ts.isTemplateExpression(node)) return null;
	return `${node.head.text}${node.templateSpans.map((span) => `\${...}${span.literal.text}`).join("")}`;
}

function expressionValueLiterals(node) {
	if (isTranslationCall(node)) return [];
	const text = literalText(node);
	if (text !== null) return [{ node, text }];
	if (
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node) ||
		ts.isSatisfiesExpression(node) ||
		ts.isNonNullExpression(node)
	) {
		return expressionValueLiterals(node.expression);
	}
	if (ts.isConditionalExpression(node)) {
		return [...expressionValueLiterals(node.whenTrue), ...expressionValueLiterals(node.whenFalse)];
	}
	if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "String") {
		return node.arguments.flatMap(expressionValueLiterals);
	}
	if (ts.isBinaryExpression(node)) {
		const operator = node.operatorToken.kind;
		if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return expressionValueLiterals(node.right);
		if (
			operator === ts.SyntaxKind.PlusToken ||
			operator === ts.SyntaxKind.BarBarToken ||
			operator === ts.SyntaxKind.QuestionQuestionToken
		) {
			return [...expressionValueLiterals(node.left), ...expressionValueLiterals(node.right)];
		}
	}
	return [];
}

function isErrorConstructor(node) {
	return ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Error";
}

function isFunctionLike(node) {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	);
}

function functionLikeName(node) {
	if ("name" in node && node.name) return propertyName(node.name);
	if (ts.isVariableDeclaration(node.parent)) return propertyName(node.parent.name);
	if (ts.isPropertyAssignment(node.parent)) return propertyName(node.parent.name);
	return null;
}

function enclosingUserMessageFunction(node) {
	let current = node.parent;
	while (current) {
		if (isFunctionLike(current)) {
			const name = functionLikeName(current);
			return name && USER_MESSAGE_FUNCTION_NAME.test(name) ? name : null;
		}
		current = current.parent;
	}
	return null;
}

function shouldSkip(relativePath) {
	const path = relativePath.split(sep).join("/");
	return (
		/\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(path) ||
		path.endsWith(".d.ts") ||
		path.endsWith("routeTree.gen.ts") ||
		path.startsWith("src/shared/i18n/")
	);
}

function sourceFiles(root) {
	const starts = [join(root, "src", "main"), join(root, "src", "renderer"), join(root, "src", "shared")];
	for (const name of ["main.ts", "preload.ts", "annotate-preload.ts"]) {
		starts.push(join(root, "src", name));
	}
	const files = [];
	const visit = (path) => {
		if (!existsSync(path)) return;
		let entries;
		try {
			entries = readdirSync(path, { withFileTypes: true });
		} catch {
			if (/\.[cm]?[jt]sx?$/.test(path)) files.push(path);
			return;
		}
		for (const entry of entries) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) visit(child);
			else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(child);
		}
	};
	for (const path of starts) visit(path);
	return [...new Set(files)].sort();
}

function allowlistKey(entry) {
	return `${entry.file}\u0000${entry.kind}\u0000${entry.text}`;
}

export function auditVisibleLiterals({ root, allowlist }) {
	const allowed = new Set(
		allowlist.map((entry) => {
			if (!entry.file || !entry.kind || !entry.text || !entry.reason) {
				throw new Error("Every i18n allowlist entry requires file, kind, text, and reason");
			}
			return allowlistKey(entry);
		}),
	);
	const violations = [];
	const allowlistHits = [];
	const hitAllowlistKeys = new Set();

	for (const filePath of sourceFiles(root)) {
		const file = relative(root, filePath).split(sep).join("/");
		if (shouldSkip(file)) continue;
		const source = readFileSync(filePath, "utf8");
		const sourceFile = ts.createSourceFile(
			filePath,
			source,
			ts.ScriptTarget.Latest,
			true,
			filePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
		);

		const report = (node, kind, rawText) => {
			const text = normalizeText(rawText);
			if (!text || !containsEnglish(text)) return;
			const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
			const violation = { file, kind, line, text };
			const key = allowlistKey(violation);
			if (allowed.has(key)) {
				hitAllowlistKeys.add(key);
				allowlistHits.push(violation);
			} else {
				violations.push(violation);
			}
		};

		const visit = (node) => {
			if (ts.isJsxText(node)) report(node, "jsx-text", node.text);

			if (ts.isJsxAttribute(node)) {
				const name = node.name.getText(sourceFile);
				if (USER_FACING_ATTRIBUTES.has(name) && node.initializer) {
					if (ts.isStringLiteral(node.initializer)) {
						report(node.initializer, `attribute:${name}`, node.initializer.text);
					} else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
						for (const value of expressionValueLiterals(node.initializer.expression)) {
							report(value.node, `attribute:${name}`, value.text);
						}
					}
				}
			}

			if (ts.isPropertyAssignment(node)) {
				const name = propertyName(node.name);
				if (name && USER_FACING_PROPERTIES.has(name)) {
					for (const value of expressionValueLiterals(node.initializer)) {
						report(value.node, `property:${name}`, value.text);
					}
				}
			}

			if (isErrorConstructor(node) && node.arguments?.[0]) {
				for (const value of expressionValueLiterals(node.arguments[0])) {
					report(value.node, "new-error", value.text);
				}
			}

			if (ts.isReturnStatement(node) && node.expression) {
				const name = enclosingUserMessageFunction(node);
				if (name) {
					for (const value of expressionValueLiterals(node.expression)) {
						report(value.node, `return:${name}`, value.text);
					}
				}
			}

			if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
				const context = jsxExpressionContext(node);
				if (context && !ts.isJsxAttribute(context.parent) && isRenderedExpressionValue(node, context)) {
					const text = literalText(node);
					if (text !== null) report(node, "jsx-expression", text);
				}
			}

			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}

	return {
		violations,
		allowlistHits,
		staleAllowlist: allowlist.filter((entry) => !hitAllowlistKeys.has(allowlistKey(entry))),
	};
}

function run() {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const allowlistPath = join(root, "scripts", "i18n-allowlist.json");
	const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8")).entries;
	const { violations, staleAllowlist } = auditVisibleLiterals({ root, allowlist });
	for (const violation of violations) {
		console.error(`${violation.file}:${violation.line} ${violation.kind} ${violation.text}`);
	}
	for (const entry of staleAllowlist) {
		console.error(`stale allowlist ${entry.file} ${entry.kind} ${entry.text}: ${entry.reason}`);
	}
	if (violations.length > 0 || staleAllowlist.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run();
