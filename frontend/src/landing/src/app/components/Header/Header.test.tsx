import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { Header } from "./Header";

const { usePathname } = vi.hoisted(() => ({ usePathname: vi.fn() }));

vi.mock("next/navigation", () => ({ usePathname }));
vi.mock("./components/AOLogo", () => ({
  AOLogo: () => <span>AO logo</span>,
}));
vi.mock("./components/DesktopNav", () => ({
  DesktopNav: () => <span>Desktop navigation</span>,
}));
vi.mock("./components/MobileNav", () => ({
  MobileNav: () => <span>Mobile navigation</span>,
}));

beforeEach(() => {
  usePathname.mockReset();
});

it("removes marketing navigation from the authenticated cloud app", () => {
  usePathname.mockReturnValue("/app");

  const { container } = render(
    <Header ctaButtons={<button>Download</button>} />,
  );

  expect(container).toBeEmptyDOMElement();
});

it("removes marketing navigation from authentication", () => {
  usePathname.mockReturnValue("/auth");

  const { container } = render(
    <Header ctaButtons={<button>Download</button>} />,
  );

  expect(container).toBeEmptyDOMElement();
});

it("keeps marketing navigation on the public site", () => {
  usePathname.mockReturnValue("/");

  render(<Header ctaButtons={<button>Download</button>} />);

  expect(screen.getByRole("banner")).toBeVisible();
  expect(screen.getByText("Desktop navigation")).toBeVisible();
});
