import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  signInWithEmail,
  signInWithGoogle,
  signOut,
  signUpWithEmail,
} from "./client";

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

  it("signs in and signs up with email credentials", async () => {
    const signInWithPassword = vi.fn().mockResolvedValue({ error: null });
    const signUp = vi.fn().mockResolvedValue({ error: null });
    const client = {
      auth: { signInWithPassword, signUp },
    } as unknown as SupabaseClient;

    await signInWithEmail(client, "developer@example.com", "password123");
    await signUpWithEmail(
      client,
      "developer@example.com",
      "password123",
      "https://ao.example/auth/callback",
    );

    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "developer@example.com",
      password: "password123",
    });
    expect(signUp).toHaveBeenCalledWith({
      email: "developer@example.com",
      password: "password123",
      options: { emailRedirectTo: "https://ao.example/auth/callback" },
    });
  });
});
