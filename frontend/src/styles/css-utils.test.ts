import { describe, expect, it } from "vitest";
import { layout, layoutCssName } from "./primitives";
import { isLayoutIconKey, kebab, layoutCssVarName } from "./css-utils";

describe("isLayoutIconKey", () => {
	it("matches icon layout keys only", () => {
		expect(isLayoutIconKey("icon2xs")).toBe(true);
		expect(isLayoutIconKey("iconXs")).toBe(true);
		expect(isLayoutIconKey("iconography")).toBe(false);
		expect(isLayoutIconKey("controlXs")).toBe(false);
	});
});

describe("layoutCssVarName", () => {
	it("maps ringWidth* keys without the size- prefix", () => {
		expect(layoutCssVarName("ringWidthFocus")).toBe("ring-width-focus");
	});

	it("maps icon and control keys under size-*", () => {
		expect(layoutCssVarName("icon2xs")).toBe("size-icon-2xs");
		expect(layoutCssVarName("iconXs")).toBe("size-icon-xs");
		expect(layoutCssVarName("controlXs")).toBe("size-control-xs");
		expect(layoutCssVarName("controlBoardSm")).toBe("size-control-board-sm");
	});

	it("matches the derived layoutCssName table for every layout key", () => {
		for (const key of Object.keys(layout) as (keyof typeof layout)[]) {
			expect(layoutCssVarName(key)).toBe(layoutCssName[key]);
		}
	});
});

describe("kebab", () => {
	it("handles dense layout keys", () => {
		expect(kebab("titlebarContentOffset")).toBe("titlebar-content-offset");
		expect(kebab("prColNumber")).toBe("pr-col-number");
	});
});
