"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { env } from "@/env";
import {
  redirectToWorkOSLogout,
  restoreWorkOSSession,
} from "@/lib/workos-cloud";
import { CloudAPI, type CloudAuthSession } from "@/lib/cloud-api";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  session: CloudAuthSession | null;
  status: AuthStatus;
  error: string | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const cloudSessionKey = "ao-cloud-session";

export function AuthProvider({
  children,
  workOSStatus,
}: {
  children: React.ReactNode;
  workOSStatus?: AuthStatus;
}) {
  const authMode = env.NEXT_PUBLIC_AO_AUTH_MODE;
  const [session, setSession] = useState<CloudAuthSession | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<CloudAuthSession | null>(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (authMode === "workos" && env.NEXT_PUBLIC_WEB_URL) {
      const canonicalOrigin = new URL(env.NEXT_PUBLIC_WEB_URL).origin;
      if (window.location.origin !== canonicalOrigin) {
        window.location.replace(
          new URL(
            `${window.location.pathname}${window.location.search}`,
            canonicalOrigin,
          ),
        );
        return;
      }
    }

    if (authMode === "workos" && workOSStatus === "loading") {
      setStatus("loading");
      return;
    }

    let active = true;
    const restore = async () => {
      let restored: CloudAuthSession | null = null;
      try {
        const stored = window.localStorage.getItem(cloudSessionKey);
        restored = stored ? (JSON.parse(stored) as CloudAuthSession) : null;
        if (authMode === "workos") {
          const workOSSession = await restoreWorkOSSession();
          if (!active) return;
          if (!workOSSession) {
            window.localStorage.removeItem(cloudSessionKey);
            setSession(null);
            setStatus("unauthenticated");
            return;
          }
          const profile = await new CloudAPI(workOSSession.accessToken).me();
          if (!active) return;
          workOSSession.user = profile.user;
          window.localStorage.setItem(
            cloudSessionKey,
            JSON.stringify(workOSSession),
          );
          setSession(workOSSession);
          setStatus("authenticated");
          return;
        }
        if (!restored) {
          setStatus("unauthenticated");
          return;
        }
        const profile = await new CloudAPI(restored.accessToken).me();
        if (!active) return;
        const hydrated = { ...restored, user: profile.user };
        window.localStorage.setItem(cloudSessionKey, JSON.stringify(hydrated));
        setSession(hydrated);
        setStatus("authenticated");
      } catch {
        if (!active) return;
        if (authMode === "workos") {
          const fallback = sessionRef.current ?? restored;
          if (fallback) {
            setSession(fallback);
            setStatus("authenticated");
            return;
          }
        }
        window.localStorage.removeItem(cloudSessionKey);
        setSession(null);
        setStatus("unauthenticated");
      }
    };
    void restore();
    let refreshTimer: number | undefined;
    const refreshNow = () => void restore();
    if (authMode === "workos") {
      refreshTimer = window.setInterval(refreshNow, 4 * 60 * 1000);
      window.addEventListener("focus", refreshNow);
    }
    return () => {
      active = false;
      if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
      window.removeEventListener("focus", refreshNow);
    };
  }, [authMode, workOSStatus]);

  const login = useCallback(async () => {
    setError(null);
    window.location.assign("/auth");
  }, []);

  const logout = useCallback(async () => {
    setError(null);
    try {
      if (session?.authProvider === "workos") {
        window.localStorage.removeItem(cloudSessionKey);
        redirectToWorkOSLogout();
        return;
      } else if (session) {
        await CloudAPI.logout(session.accessToken);
      }
    } catch (logoutError) {
      console.warn("AO Cloud logout failed", logoutError);
    }
    window.localStorage.removeItem(cloudSessionKey);
    setSession(null);
    setStatus("unauthenticated");
  }, [session]);

  const value = useMemo(
    () => ({ session, status, error, login, logout }),
    [error, login, logout, session, status],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      {error && (
        <div
          role="alert"
          className="fixed bottom-4 left-1/2 z-[100] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg border border-border bg-background px-4 py-3 text-sm text-foreground shadow-lg"
        >
          {error}
        </div>
      )}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("useAuth must be used within AuthProvider.");
  return auth;
}
