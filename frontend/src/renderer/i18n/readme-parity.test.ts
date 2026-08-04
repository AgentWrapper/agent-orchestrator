import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(process.cwd(), "..");
const translatedReadmes = {
	"README.zh-CN.md": "下载",
	"README.ja.md": "ダウンロード",
	"README.ko.md": "다운로드",
	"README.es.md": "Descargar",
	"README.fr.md": "Télécharger",
	"README.de.md": "Herunterladen",
	"README.pt-BR.md": "Baixar",
} as const;
const readmeFiles = ["README.md", ...Object.keys(translatedReadmes)];

function readReadme(file: string): string {
	return readFileSync(path.join(repositoryRoot, file), "utf8");
}

function codeBlocks(markdown: string): string[] {
	return [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]);
}

function headingLevels(markdown: string): number[] {
	return [...markdown.matchAll(/^(#{1,6})\s+/gm)].map((match) => match[1].length);
}

function operationalTargets(markdown: string): string[] {
	const markdownLinks = [...markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)].map(
		(match) => match[1],
	);
	const htmlTargets = [...markdown.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
	return [...markdownLinks, ...htmlTargets]
		.filter((target) => !/^README(?:\.[\w-]+)?\.md$/.test(target))
		.sort();
}

describe("translated README parity", () => {
	const english = readReadme("README.md");

	it("README.md links to every translation", () => {
		for (const translated of Object.keys(translatedReadmes)) expect(english).toContain(`(${translated})`);
	});

	for (const [file, downloadLabel] of Object.entries(translatedReadmes)) {
		it(`${file} keeps executable content and operational links aligned`, () => {
			const translated = readReadme(file);
			expect(codeBlocks(translated)).toEqual(codeBlocks(english));
			expect(headingLevels(translated)).toEqual(headingLevels(english));
			expect(operationalTargets(translated)).toEqual(operationalTargets(english));
			expect(translated.split(`[${downloadLabel}](`)).toHaveLength(7);
			expect(translated).not.toContain("[Download](");
			for (const sibling of readmeFiles) {
				if (sibling !== file) expect(translated, `${file} does not link to ${sibling}`).toContain(`(${sibling})`);
			}
		});
	}
});
