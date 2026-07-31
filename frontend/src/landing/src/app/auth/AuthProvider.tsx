"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Authentication failed.";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<CloudAuthSession | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    try {
      const stored = window.localStorage.getItem(cloudSessionKey);
      const restored = stored ? (JSON.parse(stored) as CloudAuthSession) : null;
      if (!restored) {
        setStatus("unauthenticated");
        return;
      }
      void new CloudAPI(restored.accessToken)
        .me()
        .then(() => {
          if (!active) return;
          setSession(restored);
          setStatus("authenticated");
        })
        .catch(() => {
          if (!active) return;
          window.localStorage.removeItem(cloudSessionKey);
          setSession(null);
          setStatus("unauthenticated");
        });
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
      if (session) await CloudAPI.logout(session.accessToken);
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
