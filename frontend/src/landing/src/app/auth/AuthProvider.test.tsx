import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "./AuthProvider";

const mocks = vi.hoisted(() => ({
  authMode: "local",
  restoreWorkOSSession: vi.fn(),
}));

vi.mock("@/env", () => ({
  env: {
    get NEXT_PUBLIC_AO_AUTH_MODE() {
      return mocks.authMode;
    },
    NEXT_PUBLIC_WEB_URL: undefined,
  },
}));

vi.mock("@/lib/workos-cloud", () => ({
  restoreWorkOSSession: mocks.restoreWorkOSSession,
  redirectToWorkOSLogout: vi.fn(),
}));

vi.mock("@/lib/cloud-api", () => ({
  CloudAPI: class {
    me = vi.fn().mockResolvedValue({
      user: {
        id: "user-one",
        email: "developer@example.com",
        displayName: "Developer",
      },
    });
  },
}));

beforeEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  mocks.authMode = "local";
  mocks.restoreWorkOSSession.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function AuthState() {
  const { session, status } = useAuth();
  return (
    <p>
      {status}:{session?.user.email ?? "none"}
    </p>
  );
}

it("restores the local control-plane session", async () => {
  window.localStorage.setItem(
    "ao-cloud-session",
    JSON.stringify({
      accessToken: "access-token",
      user: { id: "user-one", email: "developer@example.com", displayName: "Developer" },
    }),
  );

  render(
    <AuthProvider>
      <AuthState />
    </AuthProvider>,
  );

  await waitFor(() =>
    expect(
      screen.getByText("authenticated:developer@example.com"),
    ).toBeVisible(),
  );
});

it("checks the server session when AuthKit briefly reports unauthenticated", async () => {
  mocks.authMode = "workos";
  mocks.restoreWorkOSSession.mockResolvedValue({
    accessToken: "workos-access-token",
    authProvider: "workos",
    user: {
      id: "workos-user",
      email: "developer@example.com",
      displayName: "Developer",
    },
  });

  render(
    <AuthProvider workOSStatus="unauthenticated">
      <AuthState />
    </AuthProvider>,
  );

  await waitFor(() =>
    expect(
      screen.getByText("authenticated:developer@example.com"),
    ).toBeVisible(),
  );
  expect(mocks.restoreWorkOSSession).toHaveBeenCalledOnce();
});

it("keeps the cached WorkOS session when validation transiently fails", async () => {
  mocks.authMode = "workos";
  window.localStorage.setItem(
    "ao-cloud-session",
    JSON.stringify({
      accessToken: "cached-workos-token",
      authProvider: "workos",
      user: {
        id: "workos-user",
        email: "developer@example.com",
        displayName: "Developer",
      },
    }),
  );
  mocks.restoreWorkOSSession.mockRejectedValue(new Error("temporary validation failure"));

  render(
    <AuthProvider workOSStatus="authenticated">
      <AuthState />
    </AuthProvider>,
  );

  await waitFor(() =>
    expect(
      screen.getByText("authenticated:developer@example.com"),
    ).toBeVisible(),
  );
  expect(window.localStorage.getItem("ao-cloud-session")).toContain(
    "cached-workos-token",
  );
});

it("refreshes WorkOS sessions when the window regains focus", async () => {
  mocks.authMode = "workos";
  mocks.restoreWorkOSSession.mockResolvedValue({
    accessToken: "workos-access-token",
    authProvider: "workos",
    user: {
      id: "workos-user",
      email: "developer@example.com",
      displayName: "Developer",
    },
  });

  render(
    <AuthProvider workOSStatus="authenticated">
      <AuthState />
    </AuthProvider>,
  );

  await waitFor(() =>
    expect(
      screen.getByText("authenticated:developer@example.com"),
    ).toBeVisible(),
  );
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(mocks.restoreWorkOSSession).toHaveBeenCalledTimes(2));
});
