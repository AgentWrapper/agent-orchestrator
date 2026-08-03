import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { DaemonStatus } from "../../shared/daemon-status";
import {
  daemonFailureHint,
  daemonFailureMessage,
  daemonFailureTitle,
} from "../lib/daemon-failure";
import { aoBridge } from "../lib/bridge";

export function DaemonFailureBanner({ status }: { status: DaemonStatus }) {
  const [dismissed, setDismissed] = useState(false);
  const failureKey = `${status.state}:${status.code ?? ""}:${status.message ?? ""}:${status.details ?? ""}`;

  useEffect(() => {
    setDismissed(false);
  }, [failureKey]);

  if (!status.code || status.state === "ready" || dismissed) return null;
  return (
    <DaemonFailureContent
      status={status}
      onDismiss={() => setDismissed(true)}
    />
  );
}

function DaemonFailureContent({
  status,
  onDismiss,
}: {
  status: DaemonStatus;
  onDismiss: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const copiedTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const details = status.details?.trim();
  const hint = daemonFailureHint(status);
  const title = daemonFailureTitle(status);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    setCopied(false);
    setRetryError(null);
    return () => {
      if (copiedTimeout.current !== null) clearTimeout(copiedTimeout.current);
    };
  }, [details]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (document.activeElement === dialogRef.current) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const retryDaemon = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      const nextStatus = await aoBridge.daemon.restart();
      if (nextStatus.state === "error" || nextStatus.state === "stopped") {
        setRetryError(daemonFailureMessage(nextStatus));
      }
    } catch (error) {
      setRetryError(
        error instanceof Error
          ? error.message
          : "Could not restart the AO daemon.",
      );
    } finally {
      setRetrying(false);
    }
  };

  const copyDetails = async () => {
    const lines = [
      title,
      `Code: ${status.code ?? "unknown"}`,
      `Message: ${daemonFailureMessage(status)}`,
      details ? `\nDetails:\n${details}` : "",
    ];
    await aoBridge.clipboard.writeText(lines.filter(Boolean).join("\n"));
    setCopied(true);
    if (copiedTimeout.current !== null) clearTimeout(copiedTimeout.current);
    copiedTimeout.current = setTimeout(() => {
      setCopied(false);
      copiedTimeout.current = null;
    }, 2_000);
  };

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-overlay grid place-items-center bg-[var(--color-scrim)] p-4 backdrop-blur-[1px]"
      data-testid="daemon-failure-overlay"
    >
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-live="assertive"
        aria-modal="true"
        className="relative flex w-daemon-failure-toast max-w-[calc(100vw-2rem)] flex-col rounded-welcome-panel border border-[var(--color-border-import-modal)] bg-[var(--color-bg-import-modal)] px-3.5 py-3 pr-10 text-xs shadow-[var(--shadow-import-modal)]"
        onKeyDown={handleDialogKeyDown}
        ref={dialogRef}
        role="alertdialog"
        tabIndex={-1}
      >
        <button
          type="button"
          aria-label="Dismiss daemon failure"
          className="absolute right-2 top-2 grid size-control-sm place-items-center rounded-sm text-[var(--color-text-import-muted)] transition-colors hover:bg-interactive-hover hover:text-[var(--color-text-import-title)]"
          onClick={onDismiss}
        >
          <X className="size-icon-sm" aria-hidden="true" />
        </button>
        <div className="flex items-start gap-3">
          <AlertTriangle
            className="mt-0.5 size-icon-base shrink-0 text-error"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p
              className="font-medium text-(--color-text-import-title)"
              id={titleId}
            >
              {title}
            </p>
            <p
              className="mt-0.5 wrap-break-word text-[var(--color-text-import-muted)]"
              id={descriptionId}
            >
              {daemonFailureMessage(status)}
            </p>
            {hint ? (
              <p className="mt-1 text-[var(--color-text-import-muted)]">
                {hint}
              </p>
            ) : null}
          </div>
          {status.code ? (
            <code className="shrink-0 rounded-md bg-(--color-bg-import-chip) px-1.5 py-0.5 font-mono text-micro text-[var(--color-text-import-muted)]">
              {status.code}
            </code>
          ) : null}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {details ? (
              <button
                type="button"
                className="text-xs text-[var(--color-text-import-title)] underline-offset-2 hover:underline"
                onClick={() => setDetailsOpen((open) => !open)}
              >
                {detailsOpen ? "Hide details" : "Show details"}
              </button>
            ) : null}
            {details ? (
              <button
                type="button"
                className="text-xs text-[var(--color-text-import-title)] underline-offset-2 hover:underline"
                onClick={() => void copyDetails()}
              >
                {copied ? "Copied" : "Copy details"}
              </button>
            ) : null}
          </div>
          <button
            type="button"
            className="inline-flex h-control-sm items-center gap-1.5 rounded-md bg-accent-strong px-2.5 text-xs font-semibold leading-none text-accent-foreground transition-[filter] hover:brightness-110 disabled:opacity-70"
            disabled={retrying}
            onClick={() => void retryDaemon()}
          >
            <RefreshCw className="size-icon-sm" aria-hidden="true" />
            {retrying ? "Retrying..." : "Retry daemon"}
          </button>
        </div>
        {retryError ? (
          <p className="mt-2 text-xs text-error">{retryError}</p>
        ) : null}
        {details && detailsOpen ? (
          <pre className="mt-2 max-h-daemon-failure-details-max w-full overflow-auto rounded-md border border-[var(--color-border-import-modal)] bg-[var(--color-bg-import-card)] px-1.5 py-1 font-mono text-caption leading-relaxed text-[var(--color-text-import-muted)]">
            {details}
          </pre>
        ) : null}
      </section>
    </div>
  );
}
