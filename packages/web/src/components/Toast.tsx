"use client";

import { createContext, useCallback, useContext, useEffect, useReducer, useRef } from "react";
import { cn } from "@/lib/cn";

type ToastVariant = "success" | "error" | "info";

interface ToastState {
  message: string;
  variant: ToastVariant;
  key: number;
}

type ToastAction =
  | { type: "SHOW"; message: string; variant: ToastVariant; key: number }
  | { type: "HIDE" };

function toastReducer(_state: ToastState | null, action: ToastAction): ToastState | null {
  if (action.type === "SHOW") {
    return { message: action.message, variant: action.variant, key: action.key };
  }
  return null;
}

interface ToastContextValue {
  showToast: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, dispatch] = useReducer(toastReducer, null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRef = useRef(0);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const showToast = useCallback((message: string, variant: ToastVariant = "info") => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    keyRef.current += 1;
    dispatch({ type: "SHOW", message, variant, key: keyRef.current });
    timerRef.current = setTimeout(() => {
      dispatch({ type: "HIDE" });
      timerRef.current = null;
    }, 3000);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-container" role="status" aria-live="polite" aria-atomic="true">
        {toast && (
          <div
            key={toast.key}
            className={cn(
              "toast",
              toast.variant === "success" && "toast--success",
              toast.variant === "error" && "toast--error",
              toast.variant === "info" && "toast--info",
            )}
          >
            <span className="toast__icon" aria-hidden="true" />
            <span className="toast__message">{toast.message}</span>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
