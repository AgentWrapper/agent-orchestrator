"use client";

import { ArrowLeft, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { env } from "@/env";
import { CloudAPI } from "@/lib/cloud-api";
import {
  redirectToWorkOSSignIn,
  redirectToWorkOSSignUp,
} from "@/lib/workos-cloud";

import { AOLogo } from "../components/Header/components/AOLogo";
import { PrismLogoGrid } from "./PrismLogoGrid";

type Mode = "login" | "signup";

export default function EmailAuthPage() {
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const isWorkOS = env.NEXT_PUBLIC_AO_AUTH_MODE === "workos";

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const session =
        mode === "login"
            ? await CloudAPI.login({ email: email.trim(), password })
            : await CloudAPI.signUp({
                email: email.trim(),
                password,
                displayName: name.trim(),
              });
      window.localStorage.setItem("ao-cloud-session", JSON.stringify(session));
      window.location.replace("/app");
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
    <main className="grid min-h-dvh bg-[#0a0b0d] text-[#f4f5f7] lg:grid-cols-[minmax(420px,0.82fr)_minmax(520px,1.18fr)]">
      <section className="auth-form-enter relative flex min-h-dvh flex-col border-white/[0.07] px-6 py-6 sm:px-10 sm:py-8 lg:border-r lg:px-[clamp(3rem,7vw,7.5rem)]">
        <Link
          href="/"
          className="w-fit rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d8dff]"
        >
          <AOLogo />
        </Link>

        <div className="my-auto w-full max-w-[380px] py-16">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs text-[#646a73] transition-colors hover:text-[#9ba1aa] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d8dff]"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            Back to site
          </Link>

          <p className="mt-10 font-mono text-[10px] uppercase tracking-[0.16em] text-[#646a73]">
            AO Cloud
          </p>
          <h1 className="mt-3 text-[clamp(1.75rem,3vw,2.25rem)] font-medium leading-tight tracking-[-0.035em] text-[#f4f5f7]">
            {mode === "login" ? "Welcome back." : "Create your account."}
          </h1>
          <p className="mt-3 max-w-sm text-sm leading-6 text-[#9ba1aa]">
            {mode === "login"
              ? "Sign in to coordinate projects, orchestrators, and workers from anywhere."
              : "Start a cloud workspace for your agent fleet."}
          </p>

          {isWorkOS ? (
            <div className="mt-10 space-y-3">
              <button
                type="button"
                className="inline-flex h-10 w-full items-center justify-center rounded-md bg-[#4d8dff] px-4 text-sm font-medium text-white transition-[background-color,transform,opacity] hover:bg-[#397df0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8bb5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0b0d] active:scale-[0.99] motion-reduce:transform-none"
                onClick={redirectToWorkOSSignIn}
              >
                Continue with WorkOS
              </button>
              <button
                type="button"
                className="inline-flex h-10 w-full items-center justify-center rounded-md border border-white/10 bg-[#15171b] px-4 text-sm font-medium text-[#f4f5f7] transition-colors hover:border-white/15 hover:bg-[#1a1d22] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d8dff]"
                onClick={redirectToWorkOSSignUp}
              >
                Create account
              </button>
            </div>
          ) : (
          <form className="mt-10 space-y-5" onSubmit={submit}>
            {mode === "signup" && (
              <label className="block text-xs text-[#9ba1aa]">
                Name
                <input
                  className="mt-2 h-10 w-full rounded-md border border-white/10 bg-[#15171b] px-3 text-sm text-[#f4f5f7] outline-none transition-colors placeholder:text-[#646a73] hover:border-white/15 focus:border-[#4d8dff] focus:ring-1 focus:ring-[#4d8dff]/30"
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  placeholder="Ada Lovelace"
                  maxLength={120}
                />
              </label>
            )}
            <label className="block text-xs text-[#9ba1aa]">
              Email
              <input
                className="mt-2 h-10 w-full rounded-md border border-white/10 bg-[#15171b] px-3 text-sm text-[#f4f5f7] outline-none transition-colors placeholder:text-[#646a73] hover:border-white/15 focus:border-[#4d8dff] focus:ring-1 focus:ring-[#4d8dff]/30"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                placeholder="you@company.com"
                required
              />
            </label>
            <label className="block text-xs text-[#9ba1aa]">
              Password
              <input
                className="mt-2 h-10 w-full rounded-md border border-white/10 bg-[#15171b] px-3 text-sm text-[#f4f5f7] outline-none transition-colors placeholder:text-[#646a73] hover:border-white/15 focus:border-[#4d8dff] focus:ring-1 focus:ring-[#4d8dff]/30"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
                placeholder="At least 8 characters"
                minLength={8}
                required
              />
            </label>
            {error && (
              <p
                role="alert"
                className="border-l-2 border-[#ef6b6b] pl-3 text-sm leading-5 text-[#ef9b9b]"
              >
                {error}
              </p>
            )}
            {notice && (
              <p
                role="status"
                className="border-l-2 border-[#74b98a] pl-3 text-sm leading-5 text-[#9ad6ac]"
              >
                {notice}
              </p>
            )}
            <button
              type="submit"
              className="inline-flex h-10 w-full items-center justify-center rounded-md bg-[#4d8dff] px-4 text-sm font-medium text-white transition-[background-color,transform,opacity] hover:bg-[#397df0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8bb5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0b0d] active:scale-[0.99] disabled:cursor-wait disabled:opacity-50 motion-reduce:transform-none"
              disabled={busy}
            >
              {busy ? (
                <>
                  <LoaderCircle
                    className="mr-2 size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  {mode === "login" ? "Signing in…" : "Creating account…"}
                </>
              ) : mode === "login" ? (
                "Sign in"
              ) : (
                "Create account"
              )}
            </button>
          </form>
          )}

          {!isWorkOS && (
          <p className="mt-6 text-sm text-[#646a73]">
            {mode === "login"
              ? "New to Agent Orchestrator?"
              : "Already have an account?"}{" "}
            <button
              type="button"
              className="text-[#9ba1aa] underline decoration-white/20 underline-offset-4 transition-colors hover:text-[#f4f5f7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d8dff]"
              onClick={() => {
                setMode((current) =>
                  current === "login" ? "signup" : "login",
                );
                setError(null);
                setNotice(null);
              }}
            >
              {mode === "login" ? "Create an account" : "Sign in"}
            </button>
          </p>
          )}
        </div>

        <p className="text-[11px] leading-5 text-[#646a73]">
          Your sessions keep running when this window closes.
        </p>
      </section>

      <aside
        className="hidden min-h-dvh lg:block"
        aria-label="Agent Orchestrator"
      >
        <PrismLogoGrid />
      </aside>
    </main>
  );
}
