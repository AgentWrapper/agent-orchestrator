import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "@/components/StatusBadge";
import { makeSession } from "@/__tests__/helpers";

describe("StatusBadge", () => {
  it("renders the dot + label with the derived tone for a working session", () => {
    const { container } = render(
      <StatusBadge session={makeSession({ id: "w", status: "working", activity: "active" })} />,
    );
    const badge = container.querySelector(".status-badge");
    expect(badge).toHaveAttribute("data-tone", "working");
    expect(badge).toHaveAttribute("data-breathing", "");
    expect(screen.getByText("Working")).toBeInTheDocument();
  });

  it("renders a fail tone for a stuck session", () => {
    const { container } = render(
      <StatusBadge session={makeSession({ id: "s", status: "stuck", activity: "idle" })} />,
    );
    expect(container.querySelector(".status-badge")).toHaveAttribute("data-tone", "fail");
    expect(screen.getByText("Stuck")).toBeInTheDocument();
  });

  it("omits the label in dot-only mode", () => {
    const { container } = render(
      <StatusBadge
        session={makeSession({ id: "d", status: "working", activity: "active" })}
        variant="dot"
      />,
    );
    expect(container.querySelector(".status-badge--dot")).toBeInTheDocument();
    expect(screen.queryByText("Working")).not.toBeInTheDocument();
  });

  it("renders the pill variant from an explicit spec", () => {
    const { container } = render(
      <StatusBadge spec={{ tone: "ready", label: "Mergeable", breathing: false }} variant="pill" />,
    );
    const badge = container.querySelector(".status-badge--pill");
    expect(badge).toHaveAttribute("data-tone", "ready");
    expect(screen.getByText("Mergeable")).toBeInTheDocument();
  });

  it("renders nothing without a session or spec", () => {
    const { container } = render(<StatusBadge />);
    expect(container.querySelector(".status-badge")).not.toBeInTheDocument();
  });
});
