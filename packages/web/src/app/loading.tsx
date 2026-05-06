export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg-base)]">
      <div className="flex flex-col items-center gap-3">
        <svg
          className="h-5 w-5 animate-spin text-[var(--color-text-tertiary)]"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M12 3a9 9 0 1 0 9 9" />
        </svg>
        <p className="text-[13px] text-[var(--color-text-tertiary)]">
          Loading…
        </p>
      </div>
    </div>
  );
}
