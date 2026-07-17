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
						{mode === "ready" ? "Ready now" : <Icon aria-hidden="true" className="size-icon" />}
					</button>;
				}
			`,
		});

		expect(auditVisibleLiterals({ root, allowlist: [] }).violations).toEqual([
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
			{
				file: "src/renderer/Panel.tsx",
				kind: "jsx-expression",
				line: 6,
				text: "Ready now",
			},
		]);
	});

	it("reports logical branches, interpolated templates, new Error text, and translation-key-shaped visible text", () => {
		const root = fixture({
			"src/renderer/Panel.tsx": `
				export function Panel({ active, label, name, status }) {
					const notice = {
						message: \`Hello \${name}\`,
						detail: status ? "Status ready" : "Status failed",
						error: String(status || "Service failed"),
					};
					const fail = () => new Error(\`Remote failed: \${status}\`);
					return <>
						{active && "Active now"}
						{label || "Fallback label"}
						{label ?? "Missing label"}
						{active ? "Enabled now" : "Disabled now"}
						<span>{\`Welcome \${name}\`}</span>
						<span>api.error</span>
					</>;
				}
			`,
		});

		expect(auditVisibleLiterals({ root, allowlist: [] }).violations).toEqual([
			{
				file: "src/renderer/Panel.tsx",
				kind: "property:message",
				line: 4,
				text: "Hello ${...}",
			},
			{
				file: "src/renderer/Panel.tsx",
				kind: "property:detail",
				line: 5,
				text: "Status ready",
			},
			{
				file: "src/renderer/Panel.tsx",
				kind: "property:detail",
				line: 5,
				text: "Status failed",
			},
			{
				file: "src/renderer/Panel.tsx",
				kind: "property:error",
				line: 6,
				text: "Service failed",
			},
			{
				file: "src/renderer/Panel.tsx",
				kind: "new-error",
				line: 8,
				text: "Remote failed: ${...}",
			},
			{
				file: "src/renderer/Panel.tsx",
				kind: "jsx-expression",
				line: 10,
				text: "Active now",
			},
			{
				file: "src/renderer/Panel.tsx",
				kind: "jsx-expression",
				line: 11,
				text: "Fallback label",
			},
			{
				file: "src/renderer/Panel.tsx",
				kind: "jsx-expression",
				line: 12,
				text: "Missing label",
			},
			{
				file: "src/renderer/Panel.tsx",
				kind: "jsx-expression",
				line: 13,
				text: "Enabled now",
			},
			{
				file: "src/renderer/Panel.tsx",
				kind: "jsx-expression",
				line: 13,
				text: "Disabled now",
			},
			{
				file: "src/renderer/Panel.tsx",
				kind: "jsx-expression",
				line: 14,
				text: "Welcome ${...}",
			},
			{
				file: "src/renderer/Panel.tsx",
				kind: "jsx-text",
				line: 15,
				text: "api.error",
			},
		]);
	});

	it("scans shared sources, reason properties, and named user-message function returns", () => {
		const root = fixture({
			"src/main/status.ts": `
				export function daemonIdentityError() {
					return "Another AO daemon is already running.";
				}
				export function machineStatus() {
					return "ready";
				}
				class Validator {
					validationReason(path) {
						return \`Cannot import \${path}\`;
					}
					serialize() {
						return "wire-value";
					}
				}
				const response = { reason: "Origin remote is required." };
			`,
			"src/shared/errors.ts": `
				export function sharedErrorMessage() {
					return "Shared transport failure.";
				}
			`,
		});

		const violations = auditVisibleLiterals({ root, allowlist: [] }).violations;

		expect(violations).toEqual([
			{
				file: "src/main/status.ts",
				kind: "return:daemonIdentityError",
				line: 3,
				text: "Another AO daemon is already running.",
			},
			{
				file: "src/main/status.ts",
				kind: "return:validationReason",
				line: 10,
				text: "Cannot import ${...}",
			},
			{
				file: "src/main/status.ts",
				kind: "property:reason",
				line: 16,
				text: "Origin remote is required.",
			},
			{
				file: "src/shared/errors.ts",
				kind: "return:sharedErrorMessage",
				line: 3,
				text: "Shared transport failure.",
			},
		]);
		expect(violations.map((violation) => violation.text)).not.toContain("ready");
		expect(violations.map((violation) => violation.text)).not.toContain("wire-value");
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

		const result = auditVisibleLiterals({
			root,
			allowlist: [
				{
					file: "src/renderer/Panel.tsx",
					kind: "property:title",
					text: "Agent Orchestrator",
					reason: "Product name",
				},
			],
		});

		expect(result.violations).toEqual([]);
		expect(result.allowlistHits).toEqual([
			{
				file: "src/renderer/Panel.tsx",
				kind: "property:title",
				line: 3,
				text: "Agent Orchestrator",
			},
		]);
		expect(result.staleAllowlist).toEqual([]);
	});

	it("reports stale exact allowlist entries", () => {
		const root = fixture({
			"src/renderer/Panel.tsx": `export function Panel() { return <p>Translated</p>; }`,
		});
		const stale = {
			file: "src/renderer/Panel.tsx",
			kind: "jsx-text",
			text: "Removed English copy",
			reason: "Legacy product copy",
		};

		const result = auditVisibleLiterals({ root, allowlist: [stale] });

		expect(result.violations).toEqual([
			{ file: "src/renderer/Panel.tsx", kind: "jsx-text", line: 1, text: "Translated" },
		]);
		expect(result.allowlistHits).toEqual([]);
		expect(result.staleAllowlist).toEqual([stale]);
	});
});
