import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

export type { Session, SupabaseClient } from "@supabase/supabase-js";

export interface BrowserAuthConfig {
  url: string;
  anonKey: string;
}

export function createAuthBrowserClient({
  url,
  anonKey,
}: BrowserAuthConfig): SupabaseClient {
  return createBrowserClient(url, anonKey);
}

export async function signInWithGoogle(
  client: SupabaseClient,
  redirectTo: string,
) {
  return client.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo },
  });
}

export async function signInWithEmail(
  client: SupabaseClient,
  email: string,
  password: string,
) {
  return client.auth.signInWithPassword({ email, password });
}

export async function signUpWithEmail(
  client: SupabaseClient,
  email: string,
  password: string,
  emailRedirectTo: string,
) {
  return client.auth.signUp({
    email,
    password,
    options: { emailRedirectTo },
  });
}

export async function signOut(client: SupabaseClient) {
  return client.auth.signOut();
}
