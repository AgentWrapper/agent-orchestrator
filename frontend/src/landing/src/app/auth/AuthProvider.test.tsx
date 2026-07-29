import type { Session } from "@ao/auth/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { AuthProvider, useAuth } from "./AuthProvider";

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowserClient: vi.fn(),
}));

function AuthState() {
  const { session, status } = useAuth();
  return (
    <p>
      {status}:{session?.user.email ?? "none"}
    </p>
  );
}

it("loads the current session and follows auth state changes", async () => {
  const session = {
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_in: 3600,
    token_type: "bearer",
    user: { email: "developer@example.com" },
  } as Session;
  let onAuthStateChange:
    ((event: string, nextSession: Session | null) => void) | undefined;

  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session },
        error: null,
      }),
      getUser: vi.fn().mockResolvedValue({
        data: { user: session.user },
        error: null,
      }),
      onAuthStateChange: vi.fn(
        (listener: (event: string, nextSession: Session | null) => void) => {
          onAuthStateChange = listener;
          return {
            data: { subscription: { unsubscribe: vi.fn() } },
          };
        },
      ),
    },
  };

  vi.mocked(getSupabaseBrowserClient).mockReturnValue(client as never);

  render(
    <AuthProvider>
      <AuthState />
    </AuthProvider>,
  );

  expect(screen.getByText("loading:none")).toBeVisible();
  await waitFor(() =>
    expect(
      screen.getByText("authenticated:developer@example.com"),
    ).toBeVisible(),
  );
  expect(client.auth.getSession).toHaveBeenCalledOnce();
  expect(client.auth.getUser).toHaveBeenCalledOnce();

  act(() => onAuthStateChange?.("SIGNED_OUT", null));

  expect(screen.getByText("unauthenticated:none")).toBeVisible();
});
