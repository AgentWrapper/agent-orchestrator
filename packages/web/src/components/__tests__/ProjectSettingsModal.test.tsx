import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSettingsModal } from "@/components/ProjectSettingsModal";

vi.mock("@/components/ProjectSettingsForm", () => ({
  ProjectSettingsForm: () => <form aria-label="Project settings form" />,
}));

describe("ProjectSettingsModal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        project: {
          id: "alpha",
          name: "Alpha",
          path: "/tmp/alpha",
          tracker: {},
          scm: {},
        },
      }),
    } as Response);
  });

  it("does not close when a pointer drag starts inside and ends on the backdrop", async () => {
    const onClose = vi.fn();

    render(<ProjectSettingsModal open projectId="alpha" onClose={onClose} />);

    const dialog = await screen.findByRole("dialog", { name: /project settings/i });
    const backdrop = dialog.parentElement;
    if (!backdrop) throw new Error("Expected settings modal backdrop");
    const elementFromPoint = vi.fn<(x: number, y: number) => Element | null>();
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: elementFromPoint,
    });

    elementFromPoint.mockReturnValue(backdrop);
    fireEvent.pointerDown(dialog);
    fireEvent.pointerUp(backdrop);
    expect(onClose).not.toHaveBeenCalled();

    elementFromPoint.mockReturnValue(dialog);
    fireEvent.pointerDown(backdrop);
    fireEvent.pointerUp(backdrop, { clientX: 24, clientY: 24 });
    expect(onClose).not.toHaveBeenCalled();

    elementFromPoint.mockReturnValue(backdrop);
    fireEvent.pointerDown(backdrop);
    fireEvent.pointerUp(backdrop, { clientX: 4, clientY: 4 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
