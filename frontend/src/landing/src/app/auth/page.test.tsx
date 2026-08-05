import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import EmailAuthPage from "./page";

vi.mock("@/lib/cloud-api", () => ({
  CloudAPI: {
    login: vi.fn(),
    signUp: vi.fn(),
  },
}));
vi.mock("./PrismLogoGrid", () => ({
  PrismLogoGrid: () => (
    <div role="img" aria-label="Agent Orchestrator square grid" />
  ),
}));

it("presents authentication beside the animated AO grid", () => {
  render(<EmailAuthPage />);

  expect(screen.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  expect(screen.getByLabelText("Email")).toBeVisible();
  expect(screen.getByLabelText("Password")).toBeVisible();
  expect(
    screen.getByRole("img", { name: "Agent Orchestrator square grid" }),
  ).toBeInTheDocument();
});

it("switches the same form into account creation", () => {
  render(<EmailAuthPage />);

  fireEvent.click(screen.getByRole("button", { name: "Create an account" }));

  expect(
    screen.getByRole("heading", { name: "Create your account." }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Create account" })).toBeVisible();
});
