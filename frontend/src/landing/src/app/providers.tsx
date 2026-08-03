"use client";

import {
  AuthKitProvider,
  useAuth as useWorkOSAuth,
} from "@workos-inc/authkit-nextjs/components";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";

import { env } from "@/env";

import { AuthProvider } from "./auth/AuthProvider";

function WorkOSAuthBridge({ children }: { children: React.ReactNode }) {
  const { loading, user } = useWorkOSAuth();
  const status = loading
    ? "loading"
    : user
      ? "authenticated"
      : "unauthenticated";

  return <AuthProvider workOSStatus={status}>{children}</AuthProvider>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PostHogProvider client={posthog}>
      {env.NEXT_PUBLIC_AO_AUTH_MODE === "workos" ? (
        <AuthKitProvider>
          <WorkOSAuthBridge>{children}</WorkOSAuthBridge>
        </AuthKitProvider>
      ) : (
        <AuthProvider>{children}</AuthProvider>
      )}
    </PostHogProvider>
  );
}
