import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { ArtifactCardControls } from "../ArtifactCardControls";

function defaultProps() {
  return {
    collapsed: false,
    onToggleCollapse: vi.fn(),
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
    canMoveUp: true,
    canMoveDown: true,
  };
}

describe("ArtifactCardControls", () => {
  it("renders three buttons with the expected aria-labels", () => {
    const { getByLabelText } = render(<ArtifactCardControls {...defaultProps()} />);
    expect(getByLabelText("Move up")).toBeTruthy();
    expect(getByLabelText("Move down")).toBeTruthy();
    expect(getByLabelText("Collapse")).toBeTruthy();
  });

  it("shows ▾ + 'Collapse' label when expanded, ▸ + 'Expand' when collapsed", () => {
    const { getByLabelText, rerender } = render(<ArtifactCardControls {...defaultProps()} />);
    expect(getByLabelText("Collapse").textContent).toBe("▾");

    rerender(<ArtifactCardControls {...defaultProps()} collapsed={true} />);
    expect(getByLabelText("Expand").textContent).toBe("▸");
  });

  it("fires onToggleCollapse when the collapse button is clicked", () => {
    const props = defaultProps();
    const { getByLabelText } = render(<ArtifactCardControls {...props} />);
    fireEvent.click(getByLabelText("Collapse"));
    expect(props.onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it("fires onMoveUp when the up button is clicked", () => {
    const props = defaultProps();
    const { getByLabelText } = render(<ArtifactCardControls {...props} />);
    fireEvent.click(getByLabelText("Move up"));
    expect(props.onMoveUp).toHaveBeenCalledTimes(1);
  });

  it("fires onMoveDown when the down button is clicked", () => {
    const props = defaultProps();
    const { getByLabelText } = render(<ArtifactCardControls {...props} />);
    fireEvent.click(getByLabelText("Move down"));
    expect(props.onMoveDown).toHaveBeenCalledTimes(1);
  });

  it("disables the up button when canMoveUp is false", () => {
    const props = defaultProps();
    const { getByLabelText } = render(
      <ArtifactCardControls {...props} canMoveUp={false} />,
    );
    const btn = getByLabelText("Move up") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(props.onMoveUp).not.toHaveBeenCalled();
  });

  it("disables the down button when canMoveDown is false", () => {
    const props = defaultProps();
    const { getByLabelText } = render(
      <ArtifactCardControls {...props} canMoveDown={false} />,
    );
    const btn = getByLabelText("Move down") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(props.onMoveDown).not.toHaveBeenCalled();
  });

  it("disables move buttons when the corresponding callback is undefined", () => {
    const { getByLabelText } = render(
      <ArtifactCardControls
        collapsed={false}
        onToggleCollapse={vi.fn()}
        canMoveUp={true}
        canMoveDown={true}
      />,
    );
    expect((getByLabelText("Move up") as HTMLButtonElement).disabled).toBe(true);
    expect((getByLabelText("Move down") as HTMLButtonElement).disabled).toBe(true);
  });

  it("collapse button remains enabled regardless of move state", () => {
    const { getByLabelText } = render(
      <ArtifactCardControls
        collapsed={false}
        onToggleCollapse={vi.fn()}
        canMoveUp={false}
        canMoveDown={false}
      />,
    );
    expect((getByLabelText("Collapse") as HTMLButtonElement).disabled).toBe(false);
  });
});
