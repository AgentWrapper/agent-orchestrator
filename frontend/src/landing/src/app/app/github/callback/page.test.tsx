import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

import GitHubCallbackPage from "./page";

const mocks = vi.hoisted(() => ({
  pendingGitHubInstall: vi.fn(),
  confirmGitHubInstall: vi.fn(),
  replace: vi.fn(),
  auth: {
    session: {
      accessToken: "test-token",
      user: {
        id: "user-one",
        email: "user@example.com",
        displayName: "User",
      },
    },
    status: "authenticated",
  } as {
    session: {
      accessToken: string;
      user: { id: string; email: string; displayName: string };
    } | null;
    status: "loading" | "authenticated" | "unauthenticated";
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("@/lib/cloud-api", () => ({
  CloudAPI: class {
    pendingGitHubInstall = mocks.pendingGitHubInstall;
    confirmGitHubInstall = mocks.confirmGitHubInstall;
  },
}));

vi.mock("../../../auth/AuthProvider", () => ({
  useAuth: () => mocks.auth,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.session = {
    accessToken: "test-token",
    user: {
      id: "user-one",
      email: "user@example.com",
      displayName: "User",
    },
  };
  mocks.auth.status = "authenticated";
  mocks.pendingGitHubInstall.mockResolvedValue({
    accountLogin: "aoagents",
    accountType: "Organization",
    repositorySelection: "selected",
    repositoryCount: 3,
  });
  mocks.confirmGitHubInstall.mockResolvedValue(undefined);
  window.localStorage.clear();
  window.localStorage.setItem(
    "ao-cloud-selection",
    JSON.stringify({ orgId: "org-one" }),
  );
  window.history.replaceState(
    {},
    "",
    "/app/github/callback?state=opaque-state&installationId=999",
  );
});

it("shows the server-recorded summary and waits for an explicit confirmation click", async () => {
  const user = userEvent.setup();
  render(<GitHubCallbackPage />);

  await waitFor(() =>
    expect(mocks.pendingGitHubInstall).toHaveBeenCalledWith(
      "org-one",
      "opaque-state",
    ),
  );
  expect(await screen.findByText("aoagents")).toBeVisible();
  expect(screen.getByText("Organization")).toBeVisible();
  expect(screen.getByText("Selected repositories")).toBeVisible();
  expect(screen.getByText("3")).toBeVisible();
  expect(mocks.confirmGitHubInstall).not.toHaveBeenCalled();
  expect(mocks.replace).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Confirm" }));

  await waitFor(() =>
    expect(mocks.confirmGitHubInstall).toHaveBeenCalledWith("org-one", {
      state: "opaque-state",
    }),
  );
  expect(mocks.confirmGitHubInstall).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(mocks.replace).toHaveBeenCalledWith("/app?settings=github"),
  );
});

it("requires a currently selected organization", async () => {
  window.localStorage.removeItem("ao-cloud-selection");

  render(<GitHubCallbackPage />);

  expect(
    await screen.findByText(/No organization is selected/),
  ).toBeVisible();
  expect(mocks.pendingGitHubInstall).not.toHaveBeenCalled();
  expect(mocks.confirmGitHubInstall).not.toHaveBeenCalled();
});

it("shows confirmation failures without retrying automatically", async () => {
  const user = userEvent.setup();
  mocks.confirmGitHubInstall.mockRejectedValue(
    new Error("Installation state has expired."),
  );

  render(<GitHubCallbackPage />);

  await user.click(await screen.findByRole("button", { name: "Confirm" }));
  expect(
    await screen.findByText("Installation state has expired."),
  ).toBeVisible();
  expect(mocks.confirmGitHubInstall).toHaveBeenCalledTimes(1);
  expect(mocks.replace).not.toHaveBeenCalled();
});

it("cancels without confirming", async () => {
  const user = userEvent.setup();
  render(<GitHubCallbackPage />);

  await user.click(await screen.findByRole("button", { name: "Cancel" }));

  expect(mocks.confirmGitHubInstall).not.toHaveBeenCalled();
  expect(mocks.replace).toHaveBeenCalledWith("/app?settings=github");
});
