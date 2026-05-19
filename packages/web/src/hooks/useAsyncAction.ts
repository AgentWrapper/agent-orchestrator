"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncActionState {
  sending: boolean;
  sent: boolean;
  error: string | null;
}

export interface AsyncActionOptions {
  sentMs?: number;
  errorMs?: number;
}

const DEFAULT_SENT_MS = 2000;
const DEFAULT_ERROR_MS = 4000;
const IDLE_STATE: AsyncActionState = { sending: false, sent: false, error: null };

function messageFromError(err: unknown): string {
  if (err instanceof Error) return err.message || "Failed";
  if (typeof err === "string") return err || "Failed";
  return "Failed";
}

export function useAsyncAction<TArgs extends unknown[]>(
  action: (...args: TArgs) => Promise<void>,
  opts?: AsyncActionOptions,
): {
  run: (...args: TArgs) => Promise<boolean>;
  state: AsyncActionState;
  reset: () => void;
} {
  const [state, setState] = useState<AsyncActionState>(IDLE_STATE);
  const sentMs = opts?.sentMs ?? DEFAULT_SENT_MS;
  const errorMs = opts?.errorMs ?? DEFAULT_ERROR_MS;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const genRef = useRef(0);
  const mountedRef = useRef(true);

  const actionRef = useRef(action);
  actionRef.current = action;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, []);

  const clearPending = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    genRef.current += 1;
    clearPending();
    if (mountedRef.current) setState(IDLE_STATE);
  }, [clearPending]);

  const run = useCallback(
    async (...args: TArgs): Promise<boolean> => {
      const gen = genRef.current + 1;
      genRef.current = gen;
      clearPending();
      if (!mountedRef.current) return false;
      setState({ sending: true, sent: false, error: null });
      try {
        await actionRef.current(...args);
        if (!mountedRef.current || genRef.current !== gen) return true;
        setState({ sending: false, sent: true, error: null });
        timerRef.current = setTimeout(() => {
          if (genRef.current !== gen) return;
          timerRef.current = null;
          if (mountedRef.current) setState(IDLE_STATE);
        }, sentMs);
        return true;
      } catch (err) {
        if (!mountedRef.current || genRef.current !== gen) return false;
        setState({ sending: false, sent: false, error: messageFromError(err) });
        timerRef.current = setTimeout(() => {
          if (genRef.current !== gen) return;
          timerRef.current = null;
          if (mountedRef.current) setState(IDLE_STATE);
        }, errorMs);
        return false;
      }
    },
    [clearPending, sentMs, errorMs],
  );

  return { run, state, reset };
}

export function useAsyncActionMap<TArgs extends unknown[]>(
  action: (...args: TArgs) => Promise<void>,
  opts?: AsyncActionOptions,
): {
  run: (key: string, ...args: TArgs) => Promise<boolean>;
  getState: (key: string) => AsyncActionState;
  reset: (key?: string) => void;
  anySending: boolean;
} {
  const [states, setStates] = useState<Record<string, AsyncActionState>>({});
  const sentMs = opts?.sentMs ?? DEFAULT_SENT_MS;
  const errorMs = opts?.errorMs ?? DEFAULT_ERROR_MS;
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const gensRef = useRef<Map<string, number>>(new Map());
  const mountedRef = useRef(true);

  const actionRef = useRef(action);
  actionRef.current = action;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      timersRef.current.forEach((t) => clearTimeout(t));
      timersRef.current.clear();
    };
  }, []);

  const bumpGen = useCallback((key: string): number => {
    const next = (gensRef.current.get(key) ?? 0) + 1;
    gensRef.current.set(key, next);
    return next;
  }, []);

  const clearPending = useCallback((key: string) => {
    const existing = timersRef.current.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
      timersRef.current.delete(key);
    }
  }, []);

  const writeState = useCallback((key: string, next: AsyncActionState) => {
    setStates((prev) => {
      const current = prev[key];
      const isIdle = !next.sending && !next.sent && next.error === null;
      if (isIdle) {
        if (current === undefined) return prev;
        const { [key]: _removed, ...rest } = prev;
        return rest;
      }
      if (
        current &&
        current.sending === next.sending &&
        current.sent === next.sent &&
        current.error === next.error
      ) {
        return prev;
      }
      return { ...prev, [key]: next };
    });
  }, []);

  const reset = useCallback(
    (key?: string) => {
      if (key === undefined) {
        gensRef.current.clear();
        timersRef.current.forEach((t) => clearTimeout(t));
        timersRef.current.clear();
        if (mountedRef.current) setStates({});
        return;
      }
      gensRef.current.delete(key);
      bumpGen(key);
      clearPending(key);
      if (mountedRef.current) writeState(key, IDLE_STATE);
    },
    [bumpGen, clearPending, writeState],
  );

  const run = useCallback(
    async (key: string, ...args: TArgs): Promise<boolean> => {
      const gen = bumpGen(key);
      clearPending(key);
      if (!mountedRef.current) return false;
      writeState(key, { sending: true, sent: false, error: null });
      try {
        await actionRef.current(...args);
        if (!mountedRef.current || gensRef.current.get(key) !== gen) return true;
        writeState(key, { sending: false, sent: true, error: null });
        const timer = setTimeout(() => {
          if (gensRef.current.get(key) !== gen) return;
          timersRef.current.delete(key);
          gensRef.current.delete(key);
          if (mountedRef.current) writeState(key, IDLE_STATE);
        }, sentMs);
        timersRef.current.set(key, timer);
        return true;
      } catch (err) {
        if (!mountedRef.current || gensRef.current.get(key) !== gen) return false;
        writeState(key, { sending: false, sent: false, error: messageFromError(err) });
        const timer = setTimeout(() => {
          if (gensRef.current.get(key) !== gen) return;
          timersRef.current.delete(key);
          gensRef.current.delete(key);
          if (mountedRef.current) writeState(key, IDLE_STATE);
        }, errorMs);
        timersRef.current.set(key, timer);
        return false;
      }
    },
    [bumpGen, clearPending, writeState, sentMs, errorMs],
  );

  const getState = useCallback(
    (key: string): AsyncActionState => states[key] ?? IDLE_STATE,
    [states],
  );

  const anySending = Object.values(states).some((s) => s.sending);

  return { run, getState, reset, anySending };
}
