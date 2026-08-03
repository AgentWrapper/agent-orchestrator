import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "./AuthProvider";

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
