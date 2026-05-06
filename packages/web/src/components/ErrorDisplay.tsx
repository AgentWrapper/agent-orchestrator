"use client";

import Link from "next/link";
import { type ReactNode } from "react";

type ErrorTone = "error" | "warning" | "not-found";

interface ErrorAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

interface ErrorDisplayProps {
  title: string;
  message: string;
  tone?: ErrorTone;
  detailsTitle?: string;
  error?: Error & { digest?: string };
  primaryAction?: ErrorAction;
  secondaryAction?: ErrorAction;
  compact?: boolean;
  chrome?: "page" | "card";
  children?: ReactNode;
}

const toneMeta: Record<ErrorTone, { accent: string; bg: string; border: string; label: string }> = {
  error: {
    accent: "var(--color-status-error)",
    bg: "var(--color-tint-red)",
    border: "color-mix(in srgb, var(--color-status-error) 24%, transparent)",
    label: "error",
  },
  warning: {
    accent: "var(--color-status-attention)",
    bg: "var(--color-tint-yellow)",
    border: "color-mix(in srgb, var(--color-status-attention) 24%, transparent)",
    label: "warning",
  },
  "not-found": {
    accent: "var(--color-accent)",
    bg: "var(--color-tint-blue)",
    border: "color-mix(in srgb, var(--color-accent) 24%, transparent)",
    label: "missing",
  },
};

function TerminalIcon({ accent }: { accent: string }) {
  return (
    <div
      className="flex h-14 w-14 items-center justify-center rounded-2xl border"
      style={{
        background: `linear-gradient(180deg, color-mix(in srgb, ${accent} 16%, var(--color-bg-elevated)) 0%, var(--color-bg-surface) 100%)`,
        borderColor: `color-mix(in srgb, ${accent} 18%, var(--color-border-default))`,
        boxShadow: "var(--detail-card-shadow)",
      }}
    >
      <svg
        className="h-7 w-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        style={{ color: accent }}
        viewBox="0 0 24 24"
      >
        <rect x="2.5" y="4.5" width="19" height="15" rx="3" />
        <path d="M6.5 9.5l3.25 2.5-3.25 2.5M12.75 15h4.75" />
      </svg>
    </div>
  );
}

function ActionButton({ action, primary = false }: { action: ErrorAction; primary?: boolean }) {
  const className = primary
    ? "inline-flex items-center justify-center rounded-full border px-4 py-2 text-[12px] font-semibold transition-colors hover:no-underline"
    : "inline-flex items-center justify-center rounded-full border px-4 py-2 text-[12px] font-medium transition-colors hover:no-underline";
  const style = primary
    ? {
        background: "var(--color-accent)",
        color: "var(--color-text-inverse)",
        borderColor: "color-mix(in srgb, var(--color-accent) 72%, transparent)",
      }
    : {
        background: "var(--color-bg-surface)",
        color: "var(--color-text-secondary)",
        borderColor: "var(--color-border-default)",
      };

  if (action.href) {
    return (
      <Link href={action.href} className={className} style={style}>
        {action.label}
      </Link>
    );
  }

  return (
    <button type="button" onClick={action.onClick} className={className} style={style}>
      {action.label}
    </button>
  );
}

export function ErrorDisplay({
  title,
  message,
  tone = "error",
  detailsTitle = "Technical details",
  error,
  primaryAction,
  secondaryAction,
  compact = false,
  chrome = "page",
  children,
}: ErrorDisplayProps) {
  const meta = toneMeta[tone];
  const hasDetails = Boolean(error?.digest || error?.message || error?.stack);

  return (
    <div
      className={`flex w-full items-center justify-center px-6 py-10 ${compact ? "min-h-[calc(100vh-4rem)]" : "min-h-screen"}`}
      style={{
        background:
          chrome === "page"
            ? "radial-gradient(circle at top, var(--color-body-gradient-blue), transparent 35%), var(--color-bg-base)"
            : "transparent",
      }}
    >
      <div
        className="w-full max-w-[36rem] rounded-[28px] border p-6 sm:p-8"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--color-bg-elevated) 88%, transparent) 0%, var(--color-bg-surface) 100%)",
          borderColor: "var(--color-border-default)",
          boxShadow: "var(--detail-card-shadow)",
        }}
      >
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <TerminalIcon accent={meta.accent} />
            <div className="min-w-0 flex-1">
              <div
                className="mb-3 inline-flex items-center rounded-full border px-2.5 py-1 font-[var(--font-mono)] text-[10px] font-medium uppercase tracking-[0.22em]"
                style={{
                  color: meta.accent,
                  background: meta.bg,
                  borderColor: meta.border,
                }}
              >
                {meta.label}
              </div>
              <h1 className="text-[24px] font-semibold tracking-[-0.04em] text-[var(--color-text-primary)]">
                {title}
              </h1>
              <p className="mt-2 max-w-[34rem] text-[14px] leading-6 text-[var(--color-text-secondary)]">
                {message}
              </p>
            </div>
          </div>

          {(primaryAction || secondaryAction) && (
            <div className="flex flex-wrap gap-3">
              {primaryAction ? <ActionButton action={primaryAction} primary /> : null}
              {secondaryAction ? <ActionButton action={secondaryAction} /> : null}
            </div>
          )}

          {children}

          {hasDetails ? (
            <details
              className="rounded-2xl border"
              style={{
                background: "color-mix(in srgb, var(--color-bg-elevated) 84%, transparent)",
                borderColor: "var(--color-border-subtle)",
              }}
            >
              <summary className="cursor-pointer list-none px-4 py-3 text-[12px] font-medium text-[var(--color-text-secondary)]">
                {detailsTitle}
              </summary>
              <div className="border-t px-4 py-4" style={{ borderColor: "var(--color-border-subtle)" }}>
                {error?.digest ? (
                  <p className="mb-3 font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)]">
                    digest: {error.digest}
                  </p>
                ) : null}
                {error?.message ? (
                  <p className="mb-3 text-[12px] leading-5 text-[var(--color-text-secondary)]">
                    {error.message}
                  </p>
                ) : null}
                {error?.stack ? (
                  <pre className="overflow-x-auto whitespace-pre-wrap font-[var(--font-mono)] text-[11px] leading-5 text-[var(--color-text-tertiary)]">
                    {error.stack}
                  </pre>
                ) : null}
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}
