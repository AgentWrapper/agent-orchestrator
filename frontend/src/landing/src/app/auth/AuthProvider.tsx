"use client";

import { signInWithGoogle, signOut, type Session } from "@ao/auth/client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  session: Session | null;
  status: AuthStatus;
  error: string | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Authentication failed.";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const client = getSupabaseBrowserClient();
    if (!client) {
      setStatus("unauthenticated");
      return;
    }

    let active = true;

    void client.auth
      .getSession()
      .then(async ({ data, error: sessionError }) => {
        if (sessionError) throw sessionError;

        if (!data.session) return null;

        const { error: userError } = await client.auth.getUser();
        if (userError) throw userError;

        return data.session;
      })
      .then((initialSession) => {
        if (!active) return;
        setSession(initialSession);
        setStatus(initialSession ? "authenticated" : "unauthenticated");
      })
      .catch((initializationError: unknown) => {
        if (!active) return;
        setSession(null);
        setError(errorMessage(initializationError));
        setStatus("unauthenticated");
      });

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      setSession(nextSession);
      setStatus(nextSession ? "authenticated" : "unauthenticated");
      setError(null);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const login = useCallback(async () => {
    setError(null);
    const client = getSupabaseBrowserClient();
    if (!client) {
      setError("AO Cloud login is not configured for this deployment.");
      return;
    }

    const callbackUrl = new URL("/auth/callback", window.location.origin);

    try {
      const { error: loginError } = await signInWithGoogle(
        client,
        callbackUrl.toString(),
      );
      if (loginError) setError(loginError.message);
    } catch (loginError) {
      setError(errorMessage(loginError));
    }
  }, []);

  const logout = useCallback(async () => {
    setError(null);
    const client = getSupabaseBrowserClient();
    if (!client) {
      setSession(null);
      setStatus("unauthenticated");
      return;
    }

    try {
      const { error: logoutError } = await signOut(client);
      if (logoutError) {
        setError(logoutError.message);
        return;
      }
    } catch (logoutError) {
      setError(errorMessage(logoutError));
      return;
    }

    setSession(null);
    setStatus("unauthenticated");
  }, []);

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
