"use client";

import { ArrowLeft, Check, Github, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  CloudAPI,
  type CloudGitHubPendingInstallation,
} from "@/lib/cloud-api";
import { useAuth } from "../../../auth/AuthProvider";

const cloudSelectionKey = "ao-cloud-selection";
const githubSettingsPath = "/app?settings=github";

export default function GitHubCallbackPage() {
  const router = useRouter();
  const { session, status } = useAuth();
  const api = useMemo(
    () => (session?.accessToken ? new CloudAPI(session.accessToken) : null),
    [session?.accessToken],
  );
  const loadStarted = useRef(false);
  const [phase, setPhase] = useState<
    "loading" | "review" | "confirming" | "confirmed" | "error"
  >("loading");
  const [pending, setPending] =
    useState<CloudGitHubPendingInstallation | null>(null);
  const [state, setState] = useState("");
  const [orgId, setOrgId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "loading" || loadStarted.current) return;
    loadStarted.current = true;

    if (status !== "authenticated" || !api || !session) {
      setError("Your AO Cloud session has expired. Sign in again before connecting GitHub.");
      setPhase("error");
      return;
    }

    const query = new URLSearchParams(window.location.search);
    const callbackState = query.get("state")?.trim() ?? "";

    let selectedOrgId = "";
    try {
      const selection = JSON.parse(
        window.localStorage.getItem(cloudSelectionKey) ?? "{}",
      ) as { orgId?: unknown };
      if (typeof selection.orgId === "string") selectedOrgId = selection.orgId;
    } catch {
      // The error below describes the required recovery action.
    }

    if (!selectedOrgId) {
      setError(
        "No organization is selected. Return to AO Cloud, select an organization, and start the GitHub connection again.",
      );
      setPhase("error");
      return;
    }
    if (!callbackState) {
      setError("GitHub did not return the installation state. Start the connection again.");
      setPhase("error");
      return;
    }
    setState(callbackState);
    setOrgId(selectedOrgId);
    void api
      .pendingGitHubInstall(selectedOrgId, callbackState)
      .then((summary) => {
        setPending(summary);
        setPhase("review");
      })
      .catch((pendingError: unknown) => {
        setError(
          pendingError instanceof Error
            ? pendingError.message
            : "AO Cloud could not load the GitHub installation for review.",
        );
        setPhase("error");
      });
  }, [api, router, session, status]);

  const confirmInstallation = async () => {
    if (!api || !state || !orgId || phase !== "review") return;
    setError(null);
    setPhase("confirming");
    try {
      await api.confirmGitHubInstall(orgId, { state });
      setPhase("confirmed");
      router.replace(githubSettingsPath);
    } catch (confirmationError: unknown) {
      setError(
        confirmationError instanceof Error
          ? confirmationError.message
          : "AO Cloud could not confirm the GitHub installation.",
      );
      setPhase("error");
    }
  };

  return (
    <main className="grid min-h-screen place-items-center bg-[#0a0b0d] px-6 text-white">
      <section className="w-full max-w-md rounded-xl border border-white/[0.08] bg-[#15171b] p-5">
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/[0.08] bg-[#111317]">
            {phase === "confirmed" ? (
              <Check className="size-4 text-[#74b98a]" />
            ) : phase === "loading" || phase === "confirming" ? (
              <LoaderCircle className="size-4 animate-spin text-[#8eb6ff] motion-reduce:animate-none" />
            ) : (
              <Github className="size-4 text-white/55" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-medium">
              {phase === "confirmed"
                ? "GitHub connected"
                : phase === "error"
                  ? "GitHub connection failed"
                  : phase === "review"
                    ? "Review GitHub access"
                    : phase === "confirming"
                      ? "Connecting GitHub"
                      : "Loading GitHub connection"}
            </h1>
            {phase === "error" ? (
              <p className="mt-2 text-sm leading-6 text-[#ef9b9b]" role="alert">
                {error}
              </p>
            ) : phase === "review" && pending ? (
              <p className="mt-2 text-sm leading-6 text-white/45">
                Confirm that this is the GitHub account and repository access
                you intended to connect.
              </p>
            ) : (
              <p className="mt-2 text-sm leading-6 text-white/45" role="status">
                {phase === "confirmed"
                  ? "Returning to provider settings…"
                  : phase === "confirming"
                    ? "AO Cloud is binding the reviewed installation and repository grants."
                    : "AO Cloud is loading the verified installation details."}
              </p>
            )}
          </div>
        </div>
        {phase === "review" && pending ? (
          <>
            <dl className="mt-5 divide-y divide-white/[0.06] rounded-lg border border-white/[0.08] bg-[#111317] px-3">
              <div className="flex items-center justify-between gap-4 py-3">
                <dt className="text-xs text-white/45">Account</dt>
                <dd className="truncate text-sm text-white/85">
                  {pending.accountLogin}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-3">
                <dt className="text-xs text-white/45">Account type</dt>
                <dd className="text-sm text-white/85">{pending.accountType}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-3">
                <dt className="text-xs text-white/45">Repository access</dt>
                <dd className="text-sm text-white/85">
                  {pending.repositorySelection === "all"
                    ? "All repositories"
                    : "Selected repositories"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-3">
                <dt className="text-xs text-white/45">Repositories</dt>
                <dd className="text-sm text-white/85">
                  {pending.repositoryCount}
                </dd>
              </div>
            </dl>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-white/[0.1] px-3 text-sm text-white/65 transition-colors hover:bg-white/[0.05] hover:text-white"
                onClick={() => router.replace(githubSettingsPath)}
              >
                <ArrowLeft className="size-3.5" />
                Cancel
              </button>
              <button
                type="button"
                className="inline-flex h-8 items-center justify-center rounded-md bg-[#4d8dff] px-3 text-sm text-white transition-colors hover:bg-[#629bff] disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void confirmInstallation()}
              >
                Confirm
              </button>
            </div>
          </>
        ) : phase === "error" ? (
          <button
            type="button"
            className="mt-5 inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-white/[0.1] px-3 text-sm text-white/75 transition-colors hover:bg-white/[0.05] hover:text-white"
            onClick={() => router.replace(githubSettingsPath)}
          >
            <ArrowLeft className="size-3.5" />
            Return to Settings
          </button>
        ) : null}
      </section>
    </main>
  );
}
