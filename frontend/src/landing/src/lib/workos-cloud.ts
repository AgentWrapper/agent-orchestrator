import type { CloudAuthSession } from "@/lib/cloud-api";

export async function restoreWorkOSSession(): Promise<CloudAuthSession | null> {
  const response = await fetch("/api/cloud-auth/session", {
    credentials: "include",
  });
  if (!response.ok) return null;
  const session = (await response.json()) as CloudAuthSession;
  return {
    ...session,
    authProvider: "workos",
  };
}

export function redirectToWorkOSSignIn() {
  window.location.assign("/auth/workos/sign-in");
}

export function redirectToWorkOSSignUp() {
  window.location.assign("/auth/workos/sign-up");
}

export function redirectToWorkOSLogout() {
  window.location.assign("/api/cloud-auth/logout");
}
