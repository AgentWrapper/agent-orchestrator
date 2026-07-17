// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditVisibleLiterals } from "./i18n-audit.mjs";

function fixture(files) {
	const root = mkdtempSync(join(tmpdir(), "ao-i18n-audit-"));
	for (const [name, source] of Object.entries(files)) {
		const path = join(root, name);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, source);
	}
	return root;
}

describe("auditVisibleLiterals", () => {
	it("reports JSX text, user-facing attributes, expressions, and object properties", () => {
		const root = fixture({
			"src/renderer/Panel.tsx": `
				export function Panel() {
					const notice = { title: "Connection failed", detail: "Try again later" };
					return <button aria-label={"Save project"} className={"button-primary"}>
						Save changes {true ? "now" : t("actions.later")}
					</button>;
				}
			`,
		});

		expect(auditVisibleLiterals({ root, allowlist: [] })).toEqual([
			{
				file: "src/renderer/Panel.tsx",
				kind: "property:title",
				line: 3,
				text: "Connection failed",
			},
			{
				file: "src/renderer/Panel.tsx",
				kind: "property:detail",
				line: 3,
				text: "Try again later",
			},
			{
				file: "src/renderer/Panel.tsx",
				kind: "attribute:aria-label",
				line: 4,
				text: "Save project",
			},
			{
				file: "src/renderer/Panel.tsx",
				kind: "jsx-text",
				line: 5,
				text: "Save changes",
			},
			{
				file: "src/renderer/Panel.tsx",
				kind: "jsx-expression",
				line: 5,
				text: "now",
			},
		]);
	});

	it("skips tests, translation resources, translated calls, and exact allowlist entries", () => {
		const root = fixture({
			"src/renderer/Panel.tsx": `
				export function Panel({ t }) {
					const external = { title: "Agent Orchestrator" };
					return <button aria-label={t("actions.save")}>{t("actions.save")}</button>;
				}
			`,
			"src/renderer/Panel.test.tsx": `export const testLabel = <p>Must not scan tests</p>;`,
			"src/shared/i18n/en.ts": `export const en = { save: "Must not scan resources" };`,
		});

		expect(
			auditVisibleLiterals({
				root,
				allowlist: [
					{
						file: "src/renderer/Panel.tsx",
						kind: "property:title",
						text: "Agent Orchestrator",
						reason: "Product name",
					},
				],
			}),
		).toEqual([]);
	});
});
