import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { AppMark } from "@/components/AppMark";

describe("AppMark", () => {
  it("renders the blue mascot tile with the mascot image", () => {
    const { container } = render(<AppMark />);
    const mark = container.querySelector(".app-mark");
    expect(mark).toBeInTheDocument();
    const img = container.querySelector(".app-mark__img");
    expect(img).toBeInTheDocument();
    expect(img?.getAttribute("src")).toContain("mascot.png");
  });
});
