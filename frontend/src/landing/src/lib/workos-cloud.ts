import type { CloudAuthSession } from "@/lib/cloud-api";
import { env } from "@/env";

function workOSRoute(path: string) {
  const webURL = env.NEXT_PUBLIC_WEB_URL;
  return webURL ? new URL(path, webURL).toString() : path;
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

export function redirectToWorkOSSignIn() {
  window.location.assign(workOSRoute("/auth/workos/sign-in"));
}

export function redirectToWorkOSSignUp() {
  window.location.assign(workOSRoute("/auth/workos/sign-up"));
}

export function redirectToWorkOSLogout() {
  window.location.assign(workOSRoute("/api/cloud-auth/logout"));
}
