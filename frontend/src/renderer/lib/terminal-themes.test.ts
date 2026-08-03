import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTerminalThemes } from "./terminal-themes";

const tokensCss = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8");

function cssToken(block: string, name: string): string {
	const match = block.match(new RegExp(`${name}:\\s*([^;]+);`));
	if (!match) throw new Error(`Missing ${name}`);
	return match[1].trim();
}

function setCssVar(name: string, value: string): void {
	document.documentElement.style.setProperty(name, value);
}

describe("terminal theme tokens", () => {
	it("aliases light ANSI black to a soft panel token", () => {
		const lightBlock = tokensCss.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)?.[1];

		expect(lightBlock).toBeDefined();
		expect(cssToken(lightBlock!, "--color-term-black")).toBe("var(--color-term-light-black)");
	});

	it("keeps the light xterm ANSI palette readable even if dark CSS variables are active", () => {
		setCssVar("--color-term-green", "#44c97a");
		setCssVar("--color-term-yellow", "#e5c34b");
		setCssVar("--color-term-bright-green", "#62df91");
		setCssVar("--color-term-bright-yellow", "#f2d66d");
		setCssVar("--color-term-light-green", "#2e6b3e");
		setCssVar("--color-term-light-yellow", "#87660f");
		setCssVar("--color-term-light-bright-green", "#265231");
		setCssVar("--color-term-light-bright-yellow", "#6b5108");

		const { light } = buildTerminalThemes();

		expect(light.green).toBe("#2e6b3e");
		expect(light.yellow).toBe("#87660f");
		expect(light.brightGreen).toBe("#265231");
		expect(light.brightYellow).toBe("#6b5108");
	});
});