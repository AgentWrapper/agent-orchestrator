import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TitlebarNav } from "./TitlebarNav";

const { historyMock } = vi.hoisted(() => ({
	historyMock: {
		back: vi.fn(),
		forward: vi.fn(),
		location: { state: { __TSR_index: 0 } },
		subscribe: vi.fn(() => () => undefined),
	},
}));

vi.mock("@tanstack/react-router", () => ({
	useCanGoBack: () => false,
	useRouter: () => ({ history: historyMock }),
}));

vi.mock("../lib/platform", () => ({
	isLinuxPlatform: () => false,
	isMacPlatform: () => false,
}));

it("does not render the macOS/Linux navigation cluster on Windows", () => {
	const { container } = render(<TitlebarNav />);

	expect(container).toBeEmptyDOMElement();
});
