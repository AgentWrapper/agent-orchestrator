import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./badge";

describe("Badge", () => {
	it("lets text badges size to their label instead of a fixed icon square", () => {
		render(<Badge variant="success">Open</Badge>);

		expect(screen.getByText("Open")).not.toHaveClass("size-icon-xl");
	});
});
