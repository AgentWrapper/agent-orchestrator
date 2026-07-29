import { render } from "@testing-library/react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(),
}));

const originalPlatform = Object.getOwnPropertyDescriptor(window.navigator, "platform");
const originalUserAgentData = Object.getOwnPropertyDescriptor(window.navigator, "userAgentData");

function restoreProperty(name: "platform" | "userAgentData", descriptor: PropertyDescriptor | undefined) {
	if (descriptor) {
		Object.defineProperty(window.navigator, name, descriptor);
		return;
	}
	delete (window.navigator as unknown as Record<string, unknown>)[name];
}

let WindowTitlebar: typeof import("./WindowTitlebar").WindowTitlebar;

beforeAll(async () => {
	Object.defineProperty(window.navigator, "platform", {
		configurable: true,
		get: () => "MacIntel",
	});
	Object.defineProperty(window.navigator, "userAgentData", {
		configurable: true,
		get: () => ({ platform: "macOS" }),
	});
	WindowTitlebar = (await import("./WindowTitlebar")).WindowTitlebar;
});

afterAll(() => {
	restoreProperty("platform", originalPlatform);
	restoreProperty("userAgentData", originalUserAgentData);
});

it("does not render or configure native overlay controls outside Windows", () => {
	window.ao!.window.setOverlay = vi.fn().mockResolvedValue(undefined);

	const { container } = render(<WindowTitlebar />);

	expect(container).toBeEmptyDOMElement();
	expect(window.ao!.window.setOverlay).not.toHaveBeenCalled();
});
