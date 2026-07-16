import { describe, expect, it } from "vitest";

import { en } from "./en";
import { resources } from "./resources";
import { zhCN } from "./zh-CN";

type TranslationTree = string | { readonly [key: string]: TranslationTree };

function flattenKeys(tree: TranslationTree, prefix = ""): string[] {
	if (typeof tree === "string") return [prefix];

	return Object.entries(tree)
		.flatMap(([key, value]) => flattenKeys(value, prefix ? `${prefix}.${key}` : key))
		.sort();
}

function flattenLeaves(tree: TranslationTree): string[] {
	if (typeof tree === "string") return [tree];
	return Object.values(tree).flatMap(flattenLeaves);
}

describe("translation resources", () => {
	it("keeps English and Chinese key sets identical and non-empty", () => {
		expect(flattenKeys(zhCN)).toEqual(flattenKeys(en));
		expect(flattenKeys(en).length).toBeGreaterThan(0);
		expect(flattenLeaves(en).every(Boolean)).toBe(true);
		expect(flattenLeaves(zhCN).every(Boolean)).toBe(true);
	});

	it("exports both locales under the translation namespace", () => {
		expect(resources).toEqual({
			en: { translation: en },
			"zh-CN": { translation: zhCN },
		});
	});
});
