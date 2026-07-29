"use client";

import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";

import { AuthProvider } from "./auth/AuthProvider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PostHogProvider client={posthog}>
      <AuthProvider>{children}</AuthProvider>
    </PostHogProvider>
  );
}
