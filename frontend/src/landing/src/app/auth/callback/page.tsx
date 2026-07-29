"use client";

import { useEffect, useRef, useState } from "react";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

function safeRedirectPath(value: string | null) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/app";
}

export default function AuthCallbackPage() {
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const callbackUrl = new URL(window.location.href);
    const code = callbackUrl.searchParams.get("code");
    const next = safeRedirectPath(callbackUrl.searchParams.get("next"));
    const providerError = callbackUrl.searchParams.get("error_description");
    const client = getSupabaseBrowserClient();

    callbackUrl.search = "";
    window.history.replaceState(null, "", callbackUrl);

    if (providerError) {
      setError(providerError);
      return;
    }
    if (!code) {
      setError("The login callback did not include an authorization code.");
      return;
    }
    if (!client) {
      setError("AO Cloud login is not configured for this deployment.");
      return;
    }

    void client.auth
      .exchangeCodeForSession(code)
      .then(({ error }) => {
        if (error) {
          setError(error.message);
          return;
        }
        window.location.replace(next);
      })
      .catch((exchangeError: unknown) => {
        setError(
          exchangeError instanceof Error
            ? exchangeError.message
            : "Unable to complete login.",
        );
      });
  }, []);

  return (
    <main className="flex min-h-[calc(100dvh-3.5rem)] items-center justify-center bg-background px-4">
      <section className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground">
          AO Cloud
        </p>
        <h1 className="mt-3 text-xl font-medium text-foreground">
          {error ? "Login failed" : "Completing login"}
        </h1>
        <p
          className="mt-2 text-sm text-muted-foreground"
          role={error ? "alert" : undefined}
        >
          {error ?? "Verifying your Google account…"}
        </p>
        {error && (
          <a
            href="/"
            className="mt-5 inline-flex h-9 items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            Return home
          </a>
        )}
      </section>
    </main>
  );
}
