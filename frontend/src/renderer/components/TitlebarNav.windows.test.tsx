import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TitlebarNav } from "./TitlebarNav";

vi.mock("@tanstack/react-router", () => ({
	useCanGoBack: () => false,
	useRouter: () => ({
		history: {
			location: { state: { __TSR_index: 0 } },
			subscribe: () => () => undefined,
		},
	}),
}));

vi.mock("../lib/platform", () => ({
	isLinuxPlatform: () => false,
	isMacPlatform: () => false,
}));

it("leaves Windows navigation to the custom WindowTitlebar", () => {
	const { container } = render(<TitlebarNav />);

	expect(container).toBeEmptyDOMElement();
});
