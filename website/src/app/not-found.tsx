import Link from "next/link";

export default function NotFound() {
  return (
    <main className="landing-page min-h-screen overflow-hidden">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col justify-center px-6 py-20">
        <a
          href="/"
          className="mb-14 inline-flex w-fit items-center gap-2 text-sm font-semibold text-white no-underline"
        >
          <img src="/ao-logo.svg" alt="" aria-hidden="true" width={28} height={28} className="h-7 w-7" />
          Agent Orchestrator
        </a>

        <div className="grid gap-10 md:grid-cols-[1fr_360px] md:items-end">
          <section>
            <p className="mb-4 font-mono text-xs uppercase tracking-[0.28em] text-[var(--landing-accent)]">
              404 / route missing
            </p>
            <h1 className="max-w-3xl text-[clamp(2.75rem,8vw,6rem)] font-[680] leading-[0.95] tracking-tight text-white">
              This path is not in the fleet.
            </h1>
            <p className="mt-6 max-w-xl text-base leading-7 text-[var(--landing-muted)]">
              The page may have moved during the rebuild, or the URL may be out of date. Start from the
              product site or jump straight into the docs.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/"
                className="inline-flex h-10 items-center justify-center rounded-md bg-[var(--landing-accent)] px-4 text-sm font-semibold text-[#121110] no-underline transition-opacity hover:opacity-90"
              >
                Go home
              </Link>
              <Link
                href="/docs"
                className="inline-flex h-10 items-center justify-center rounded-md border border-[var(--landing-border-default)] px-4 text-sm font-semibold text-white no-underline transition-colors hover:border-[var(--landing-border-strong)]"
              >
                Browse docs
              </Link>
            </div>
          </section>

          <aside className="font-mono text-sm text-[var(--landing-muted)]">
            <div className="rounded-lg border border-[var(--landing-border-subtle)] bg-[var(--landing-surface)] p-5">
              <div className="mb-4 flex gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-[#ef4444]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#f59e0b]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#22c55e]" />
              </div>
              <p className="mb-2 text-[var(--landing-muted-dim)]">$ ao route inspect</p>
              <p className="mb-2 text-white">status: not_found</p>
              <p className="text-[var(--landing-muted)]">next: /docs</p>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
