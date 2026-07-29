import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { signInWithGoogle, signOut } from "./client";

describe("browser auth actions", () => {
  it("starts Google OAuth with the callback URL", async () => {
    const signInWithOAuth = vi.fn().mockResolvedValue({
      data: { provider: "google", url: "https://accounts.google.com" },
      error: null,
    });
    const client = {
      auth: { signInWithOAuth },
    } as unknown as SupabaseClient;

    await signInWithGoogle(client, "https://ao.example/auth/callback");

    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: "https://ao.example/auth/callback" },
    });
  });

  it("ends the Supabase session", async () => {
    const signOutClient = vi.fn().mockResolvedValue({ error: null });
    const client = {
      auth: { signOut: signOutClient },
    } as unknown as SupabaseClient;

    await signOut(client);

    expect(signOutClient).toHaveBeenCalledOnce();
  });
});
