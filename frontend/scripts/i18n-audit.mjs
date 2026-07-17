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
	"detail",
	"label",
	"description",
	"subtitle",
]);

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
	const starts = [join(root, "src", "main"), join(root, "src", "renderer")];
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
			if (!allowed.has(allowlistKey(violation))) violations.push(violation);
		};

		const visit = (node) => {
			if (ts.isJsxText(node)) report(node, "jsx-text", node.text);

			if (ts.isJsxAttribute(node)) {
				const name = node.name.getText(sourceFile);
				if (USER_FACING_ATTRIBUTES.has(name) && node.initializer && ts.isStringLiteral(node.initializer)) {
					report(node.initializer, `attribute:${name}`, node.initializer.text);
				}
			}

			if (ts.isPropertyAssignment(node)) {
				const name = propertyName(node.name);
				if (
					name &&
					USER_FACING_PROPERTIES.has(name) &&
					(ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))
				) {
					report(node.initializer, `property:${name}`, node.initializer.text);
				}
			}

			if (
				(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
				node.parent &&
				ts.isJsxExpression(node.parent)
			) {
				report(node, "jsx-expression", node.text);
			}

			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}

	return violations;
}

function run() {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const allowlistPath = join(root, "scripts", "i18n-allowlist.json");
	const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8")).entries;
	const violations = auditVisibleLiterals({ root, allowlist });
	for (const violation of violations) {
		console.error(`${violation.file}:${violation.line} ${violation.kind} ${violation.text}`);
	}
	if (violations.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run();
