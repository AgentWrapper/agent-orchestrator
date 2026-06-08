import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RemoveProjectConfirmModal } from "../RemoveProjectConfirmModal";

const project = { id: "project-1", name: "Project One", sessionPrefix: "project-1" };

describe("RemoveProjectConfirmModal", () => {
  it("traps Tab focus within the dialog", () => {
    render(
      <RemoveProjectConfirmModal
        project={project}
        busy={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: /Remove Project One/i });
    const close = screen.getByRole("button", { name: "Close" });
    const remove = screen.getByRole("button", { name: "Remove from AO" });

    remove.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    close.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(remove);
  });

  it("calls onCancel when Escape is pressed", () => {
    const onCancel = vi.fn();
    render(
      <RemoveProjectConfirmModal
        project={project}
        busy={false}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("dialog", { name: /Remove Project One/i }), {
      key: "Escape",
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not call onCancel on Escape while busy", () => {
    const onCancel = vi.fn();
    render(
      <RemoveProjectConfirmModal
        project={project}
        busy={true}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("dialog", { name: /Remove Project One/i }), {
      key: "Escape",
    });

    expect(onCancel).not.toHaveBeenCalled();
  });
});
