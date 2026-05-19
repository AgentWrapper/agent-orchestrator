import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardNotificationRecord } from "@/lib/mux-protocol";

let muxValue: {
  notifications: DashboardNotificationRecord[];
  notificationLimit: number;
  notificationError: string | null;
};

vi.mock("@/providers/MuxProvider", () => ({
  useMuxOptional: () => muxValue,
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { DashboardNotificationButton } from "../DashboardNotificationButton";

function makeV3Data(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    subject: {
      session: { id: "worker-1", projectId: "demo" },
      pr: { number: 1, url: "https://github.com/acme/app/pull/1" },
    },
    ...overrides,
  };
}

function makeNotification(id: string, message: string): DashboardNotificationRecord {
  return {
    id: `${id}:2026-05-13T12:00:00.000Z`,
    receivedAt: `2026-05-13T12:00:0${id}.000Z`,
    event: {
      id,
      type: "session.needs_input",
      priority: "action",
      sessionId: "worker-1",
      projectId: "demo",
      timestamp: "2026-05-13T12:00:00.000Z",
      message,
      data: makeV3Data(),
    },
  };
}

function makePriorityNotification(
  id: string,
  priority: string,
  message: string,
): DashboardNotificationRecord {
  return {
    ...makeNotification(id, message),
    event: {
      ...makeNotification(id, message).event,
      priority,
      message,
    },
  };
}

function makeSuccessNotification(
  id: string,
  type: string,
  message: string,
): DashboardNotificationRecord {
  return {
    ...makeNotification(id, message),
    event: {
      ...makeNotification(id, message).event,
      type,
      priority: type === "summary.all_complete" ? "info" : "action",
      message,
      data:
        type === "summary.all_complete"
          ? makeV3Data({ semanticType: "summary.all_complete" })
          : makeV3Data({ semanticType: "merge.ready", merge: { ready: true } }),
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  muxValue = {
    notifications: [
      makeNotification("1", "First notification"),
      makeNotification("2", "Second notification"),
    ],
    notificationLimit: 50,
    notificationError: null,
  };
});

describe("DashboardNotificationButton", () => {
  it("only toggles the panel from an explicit trigger click", () => {
    render(<DashboardNotificationButton />);
    const trigger = screen.getByRole("button", { name: "Notifications" });

    fireEvent.mouseEnter(trigger);
    expect(screen.queryByRole("dialog", { name: "Notifications" })).not.toBeInTheDocument();

    fireEvent.focus(trigger);
    expect(screen.queryByRole("dialog", { name: "Notifications" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog", { name: "Notifications" })).not.toBeInTheDocument();
  });

  it("toggles one notification and all notifications between read and unread", () => {
    render(<DashboardNotificationButton />);

    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Unread 2" })).toBeInTheDocument();
    expect(screen.queryByText("2/50 retained")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Mark read" })[0]);
    expect(screen.getByRole("tab", { name: "Unread 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark unread" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    expect(screen.getByRole("tab", { name: "Unread 0" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark read" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark all unread" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Mark unread" })).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Mark all unread" }));
    expect(screen.getByRole("tab", { name: "Unread 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Mark read" })).toHaveLength(2);
  });

  it("filters the list to unread notifications", () => {
    render(<DashboardNotificationButton />);

    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Mark read" })[0]);
    fireEvent.click(screen.getByRole("tab", { name: "Unread 1" }));

    expect(screen.getByRole("tab", { name: "Unread 1" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByText("Second notification")).not.toBeInTheDocument();
    expect(screen.getByText("First notification")).toBeInTheDocument();
  });

  it("uses distinct classes for urgent and action notification colors", () => {
    muxValue.notifications = [
      makePriorityNotification("1", "urgent", "Urgent notification"),
      makePriorityNotification("2", "action", "Action notification"),
    ];

    render(<DashboardNotificationButton />);

    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));

    expect(screen.getByText("urgent")).toBeInTheDocument();
    expect(screen.getByText("action")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")[0]).toHaveClass("dashboard-notification-item--action");
    expect(screen.getAllByRole("listitem")[1]).toHaveClass("dashboard-notification-item--urgent");
  });

  it("uses green success labels for approved and all-complete notifications", () => {
    muxValue.notifications = [
      makeSuccessNotification("1", "merge.ready", "PR is ready to merge"),
      makeSuccessNotification("2", "summary.all_complete", "All sessions complete"),
    ];

    render(<DashboardNotificationButton />);

    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));

    expect(screen.getByText("approved")).toBeInTheDocument();
    expect(screen.getByText("all complete")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")[0]).toHaveClass("dashboard-notification-item--success");
    expect(screen.getAllByRole("listitem")[1]).toHaveClass("dashboard-notification-item--success");
  });

  it("hides redundant dashboard and PR actions from notification cards", () => {
    muxValue.notifications = [
      {
        ...makeNotification("1", "CI failed"),
        actions: [
          { label: "Open dashboard", url: "http://localhost:3000" },
          { label: "View PR", url: "https://github.com/acme/app/pull/1" },
          { label: "CI run", url: "https://github.com/acme/app/actions/runs/1" },
        ],
      },
    ];

    render(<DashboardNotificationButton />);

    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));

    expect(screen.queryByRole("link", { name: "Open dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View PR" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PR" })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/pull/1",
    );
    expect(screen.getByRole("link", { name: "CI run" })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/actions/runs/1",
    );
  });

  it("does not render unsafe notification URLs", () => {
    muxValue.notifications = [
      {
        ...makeNotification("1", "Suspicious notification"),
        event: {
          ...makeNotification("1", "Suspicious notification").event,
          data: makeV3Data({
            subject: {
              session: { id: "worker-1", projectId: "demo" },
              pr: { number: 1, url: "javascript:alert(1)" },
            },
            review: { url: "data:text/html,<script>alert(1)</script>" },
          }),
        },
        actions: [
          { label: "Unsafe action", url: "javascript:alert(1)" },
          { label: "Unsafe external action", url: "https://evil.example/phish" },
          { label: "Safe action", url: "https://github.com/acme/app/actions/runs/1" },
        ],
      },
    ];

    render(<DashboardNotificationButton />);

    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));

    expect(screen.queryByRole("link", { name: "PR" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Unsafe action" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Unsafe external action" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Safe action" })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/actions/runs/1",
    );
  });
});
