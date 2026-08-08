import { useEffect, useState } from "react";
import { aoBridge } from "./bridge";
import type { CloudSession } from "../../main/cloud-auth";

export type { CloudSession };

export type CloudSessionStatus = "loading" | "authenticated" | "unauthenticated";

export interface UseCloudSessionResult {
  session: CloudSession | null;
  status: CloudSessionStatus;
  signIn: (returnTo?: string) => void;
  signOut: () => Promise<void>;
}

export function useCloudSession(): UseCloudSessionResult {
  const [session, setSession] = useState<CloudSession | null>(null);
  const [status, setStatus] = useState<CloudSessionStatus>("loading");

  useEffect(() => {
    let active = true;
    aoBridge.cloud.getSession().then((s) => {
      if (!active) return;
      setSession(s);
      setStatus(s ? "authenticated" : "unauthenticated");
    }).catch(() => {
      if (!active) return;
      setSession(null);
      setStatus("unauthenticated");
    });

    const unsub = aoBridge.cloud.onSessionChanged((s) => {
      setSession(s);
      setStatus(s ? "authenticated" : "unauthenticated");
    });

    return () => {
      active = false;
      unsub();
    };
  }, []);

  const signIn = () => {
    void aoBridge.cloud.signIn();
  };

  const signOut = async () => {
    await aoBridge.cloud.signOut();
    setSession(null);
    setStatus("unauthenticated");
  };

  return { session, status, signIn, signOut };
}
