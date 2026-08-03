"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
const authMode = env.NEXT_PUBLIC_AO_AUTH_MODE;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Authentication failed.";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<CloudAuthSession | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const restore = async () => {
      try {
        const stored = window.localStorage.getItem(cloudSessionKey);
        const restored = stored ? (JSON.parse(stored) as CloudAuthSession) : null;
        if (authMode === "workos") {
          const workOSSession = await restoreWorkOSSession();
          if (!active) return;
          if (!workOSSession) {
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
      } catch (initializationError) {
        if (!active) return;
        setError(errorMessage(initializationError));
        window.localStorage.removeItem(cloudSessionKey);
        setSession(null);
        setStatus("unauthenticated");
      }
    };
    try {
      void restore();
    } catch (initializationError) {
      setError(errorMessage(initializationError));
      setStatus("unauthenticated");
    }
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async () => {
    setError(null);
    window.location.assign("/auth");
  }, []);

  const logout = useCallback(async () => {
    setError(null);
    try {
      if (session?.authProvider === "workos") {
        window.localStorage.removeItem(cloudSessionKey);
        setSession(null);
        setStatus("unauthenticated");
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
