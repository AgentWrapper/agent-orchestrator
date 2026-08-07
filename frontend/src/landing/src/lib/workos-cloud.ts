import type { CloudAuthSession } from "@/lib/cloud-api";
import { env } from "@/env";

function workOSRoute(path: string, returnTo?: string) {
  const webURL = env.NEXT_PUBLIC_WEB_URL;
  const route = new URL(path, webURL ?? "https://ao.local");
  if (returnTo) route.searchParams.set("returnTo", returnTo);
  return webURL ? route.toString() : `${route.pathname}${route.search}`;
}

export async function restoreWorkOSSession(): Promise<CloudAuthSession | null> {
  try {
    const response = await fetch(workOSRoute("/api/cloud-auth/session"), {
      credentials: "include",
    });
    if (!response.ok) return null;
    const session = (await response.json()) as CloudAuthSession;
    return {
      ...session,
      authProvider: "workos",
    };
  } catch {
    return null;
  }
}

export function redirectToWorkOSSignIn(returnTo?: string) {
  window.location.assign(workOSRoute("/auth/workos/sign-in", returnTo));
}

export function redirectToWorkOSSignUp(returnTo?: string) {
  window.location.assign(workOSRoute("/auth/workos/sign-up", returnTo));
}

export function redirectToWorkOSLogout() {
  window.location.assign(workOSRoute("/api/cloud-auth/logout"));
}
