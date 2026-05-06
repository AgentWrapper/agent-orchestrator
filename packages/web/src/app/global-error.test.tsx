import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const errorDisplaySpy = vi.fn();

vi.mock("@/components/ErrorDisplay", () => ({
  ErrorDisplay: (props: {
    title: string;
    message: string;
    primaryAction?: { label: string; onClick?: () => void };
    secondaryAction?: { label: string; onClick?: () => void };
  }) => {
    errorDisplaySpy(props);
    return (
      <div>
        <div>{props.title}</div>
        <div>{props.message}</div>
        {props.primaryAction ? (
          <button type="button" onClick={props.primaryAction.onClick}>
            {props.primaryAction.label}
          </button>
        ) : null}
        {props.secondaryAction ? (
          <button type="button" onClick={props.secondaryAction.onClick}>
            {props.secondaryAction.label}
          </button>
        ) : null}
      </div>
    );
  },
}));

import GlobalError from "./global-error";

describe("Global error boundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    errorDisplaySpy.mockClear();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload: vi.fn() },
    });
  });

  it("calls reset when retrying", () => {
    const reset = vi.fn();

    render(<GlobalError error={new Error("layout failed")} reset={reset} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("reloads the page on demand", () => {
    render(<GlobalError error={new Error("layout failed")} reset={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it("passes the expected shell copy to ErrorDisplay", () => {
    render(<GlobalError error={new Error("layout failed")} reset={vi.fn()} />);

    expect(errorDisplaySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Something broke at the app shell",
        message:
          "The dashboard could not recover from this error at the layout level. Try again first, then reload the page if it still fails.",
      }),
    );
  });
});
