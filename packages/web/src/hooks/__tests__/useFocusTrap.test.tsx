import { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFocusTrap } from "@/hooks/useFocusTrap";

function FocusTrapFixture() {
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(true, containerRef);

  return (
    <div ref={containerRef} role="dialog" tabIndex={-1}>
      <button type="button">First visible</button>
      <button type="button">Last visible</button>
      <button type="button" style={{ display: "none" }}>
        Hidden tail
      </button>
    </div>
  );
}

describe("useFocusTrap", () => {
  it("skips hidden focusable elements when wrapping focus", () => {
    render(<FocusTrapFixture />);

    const first = screen.getByRole("button", { name: /first visible/i });
    const last = screen.getByRole("button", { name: /last visible/i });
    expect(first).toHaveFocus();

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });

    expect(first).toHaveFocus();
  });
});
