import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HeaderCTA } from "./HeaderCTA";

const auth = vi.hoisted(() => ({
  current: {
    status: "unauthenticated",
    login: vi.fn(),
    logout: vi.fn(),
  },
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => auth.current,
}));

vi.mock("../DownloadButton", () => ({
  DownloadButton: () => <a href="/download">Download</a>,
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("HeaderCTA", () => {
  beforeEach(() => {
    auth.current.status = "unauthenticated";
    auth.current.login.mockReset();
    auth.current.logout.mockReset();
  });

  it("shows Login beside Download and starts Google login", async () => {
    const user = userEvent.setup();
    render(<HeaderCTA />);

    await user.click(screen.getByRole("button", { name: "Login" }));

    expect(auth.current.login).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Download" })).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Open app" }),
    ).not.toBeInTheDocument();
  });

  it("shows Open app and logs an authenticated user out", async () => {
    auth.current.status = "authenticated";
    const user = userEvent.setup();
    render(<HeaderCTA />);

    expect(screen.getByRole("link", { name: "Open app" })).toHaveAttribute(
      "href",
      "/app",
    );
    await user.click(screen.getByRole("button", { name: "Logout" }));

    expect(auth.current.logout).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "Login" }),
    ).not.toBeInTheDocument();
  });
});
