import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aoBridge } from "../lib/bridge";
import { DaemonFailureBanner } from "./DaemonFailureBanner";

describe("DaemonFailureBanner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shows the daemon failure message, code, and actionable hint", () => {
    render(
      <DaemonFailureBanner
        status={{
          state: "stopped",
          code: "exited",
          message: "AO daemon exited with code 1",
          details: "go: go.mod requires go >= 1.25.7",
        }}
      />,
    );

    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "AO daemon failed to start",
    );
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "AO daemon exited with code 1",
    );
    expect(screen.getByText("exited")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry daemon" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(
      screen.getByText("go: go.mod requires go >= 1.25.7"),
    ).toBeInTheDocument();
  });

  it("presents startup failures as a centered blocking overlay", () => {
    render(
      <DaemonFailureBanner status={{ state: "stopped", code: "exited" }} />,
    );

    expect(screen.getByTestId("daemon-failure-overlay")).toHaveClass(
      "fixed",
      "inset-0",
      "place-items-center",
    );
    expect(screen.getByRole("alertdialog")).toHaveClass(
      "w-daemon-failure-toast",
      "max-w-[calc(100vw-2rem)]",
    );
    expect(screen.getByRole("alertdialog")).not.toHaveClass("right-3", "top-3");
  });

  it("marks the blocking overlay as a modal alert dialog and focuses it", () => {
    render(
      <DaemonFailureBanner status={{ state: "stopped", code: "exited" }} />,
    );

    const dialog = screen.getByRole("alertdialog");

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("AO daemon failed to start");
    expect(dialog).toHaveAccessibleDescription("AO daemon is not ready.");
    expect(dialog).toHaveFocus();
  });

  it("keeps keyboard focus inside the blocking overlay", () => {
    render(
      <DaemonFailureBanner
        status={{ state: "stopped", code: "exited", details: "failure" }}
      />,
    );
    const dialog = screen.getByRole("alertdialog");
    const dismiss = screen.getByRole("button", {
      name: "Dismiss daemon failure",
    });
    const retry = screen.getByRole("button", { name: "Retry daemon" });

    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dismiss).toHaveFocus();

    fireEvent.keyDown(dismiss, { key: "Tab", shiftKey: true });
    expect(retry).toHaveFocus();

    fireEvent.keyDown(retry, { key: "Tab" });
    expect(dismiss).toHaveFocus();
  });

  it("retries daemon startup from the failure overlay", async () => {
    const restart = vi
      .spyOn(aoBridge.daemon, "restart")
      .mockResolvedValue({ state: "starting" });
    render(
      <DaemonFailureBanner status={{ state: "stopped", code: "exited" }} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry daemon" }));

    await waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
  });

  it("shows retry errors instead of leaking unhandled rejections", async () => {
    vi.spyOn(aoBridge.daemon, "restart").mockRejectedValue(
      new Error("spawn failed"),
    );
    render(
      <DaemonFailureBanner status={{ state: "stopped", code: "exited" }} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry daemon" }));

    expect(await screen.findByText("spawn failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry daemon" })).toBeEnabled();
  });

  it("shows daemon retry status failures inline", async () => {
    vi.spyOn(aoBridge.daemon, "restart").mockResolvedValue({
      state: "error",
      code: "not_ready",
    });
    render(
      <DaemonFailureBanner status={{ state: "error", code: "not_ready" }} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry daemon" }));

    expect(
      await screen.findByText("AO daemon is not ready."),
    ).toBeInTheDocument();
  });

  it("lets users dismiss the blocking failure overlay", () => {
    render(
      <DaemonFailureBanner status={{ state: "stopped", code: "exited" }} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss daemon failure" }),
    );

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("dismisses the blocking failure overlay with Escape", () => {
    render(
      <DaemonFailureBanner status={{ state: "stopped", code: "exited" }} />,
    );

    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("resets copy feedback when failure details change", async () => {
    const { rerender } = render(
      <DaemonFailureBanner
        status={{ state: "stopped", code: "exited", details: "first failure" }}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

    rerender(
      <DaemonFailureBanner
        status={{ state: "stopped", code: "exited", details: "second failure" }}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Copy details" }),
    ).toBeInTheDocument();
  });

  it("resets copy feedback after two seconds", async () => {
    vi.useFakeTimers();
    render(
      <DaemonFailureBanner
        status={{ state: "stopped", code: "exited", details: "failure" }}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(2_000));

    expect(
      screen.getByRole("button", { name: "Copy details" }),
    ).toBeInTheDocument();
  });

  it("renders nothing while the daemon is not in an error state", () => {
    const { container } = render(
      <DaemonFailureBanner status={{ state: "starting" }} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
