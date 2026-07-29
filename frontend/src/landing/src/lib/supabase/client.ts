import { createAuthBrowserClient, type SupabaseClient } from "@ao/auth/client";

import { env } from "@/env";

let browserClient: SupabaseClient | null | undefined;

export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (browserClient !== undefined) return browserClient;

  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  browserClient =
    url && anonKey ? createAuthBrowserClient({ url, anonKey }) : null;

  return browserClient;
}
