"use client";

import { signInWithEmail, signUpWithEmail } from "@ao/auth/client";
import { ArrowLeft, LoaderCircle, Mail } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type Mode = "login" | "signup";

export default function EmailAuthPage() {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const client = getSupabaseBrowserClient();
    if (!client) {
      setError("AO Cloud authentication is not configured.");
      setBusy(false);
      return;
    }

    try {
      if (mode === "login") {
        const { data, error: loginError } = await signInWithEmail(
          client,
          email.trim(),
          password,
        );
        if (loginError) throw loginError;
        if (!data.session) {
          throw new Error("Supabase did not create a login session.");
        }
        window.location.replace("/app");
        return;
      }

      const callback = new URL("/auth/callback", window.location.origin);
      callback.searchParams.set("next", "/app");
      const { data, error: signupError } = await signUpWithEmail(
        client,
        email.trim(),
        password,
        callback.toString(),
      );
      if (signupError) throw signupError;
      if (data.session) {
        window.location.replace("/app");
        return;
      }
      setNotice(
        "Check your inbox to confirm the account, then return here to sign in.",
      );
      setMode("login");
      setPassword("");
    } catch (authError) {
      setError(
        authError instanceof Error
          ? authError.message
          : "Authentication failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-[calc(100dvh-3.5rem)] place-items-center bg-background px-4 py-10">
      <section className="w-full max-w-sm border border-border bg-card p-6">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back
        </Link>
        <div className="mt-6 flex size-8 items-center justify-center rounded-md border border-border bg-background">
          <Mail className="size-4 text-[#4d8dff]" />
        </div>
        <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          AO Cloud
        </p>
        <h1 className="mt-2 text-xl font-medium text-foreground">
          {mode === "login" ? "Sign in with email" : "Create your account"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {mode === "login"
            ? "Continue to your cloud projects and running agents."
            : "Use an email address you can confirm."}
        </p>

        <form className="mt-6 space-y-3" onSubmit={submit}>
          <label className="block text-xs text-muted-foreground">
            Email
            <input
              className="mt-1.5 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-[#4d8dff]"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
            />
          </label>
          <label className="block text-xs text-muted-foreground">
            Password
            <input
              className="mt-1.5 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-[#4d8dff]"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              minLength={8}
              required
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="text-sm leading-6 text-emerald-400">
              {notice}
            </p>
          )}
          <button
            type="submit"
            className="inline-flex h-9 w-full items-center justify-center rounded-md bg-[#4d8dff] px-4 text-sm text-white transition-colors hover:bg-[#397df0] disabled:cursor-wait disabled:opacity-50"
            disabled={busy}
          >
            {busy ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : mode === "login" ? (
              "Sign in"
            ) : (
              "Create account"
            )}
          </button>
        </form>

        <button
          type="button"
          className="mt-4 text-sm text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => {
            setMode((current) => (current === "login" ? "signup" : "login"));
            setError(null);
            setNotice(null);
          }}
        >
          {mode === "login"
            ? "Need an account? Sign up"
            : "Already have an account? Sign in"}
        </button>
      </section>
    </main>
  );
}
