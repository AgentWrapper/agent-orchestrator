import Link from "next/link";

// Root not-found: also emitted as 404.html in the static export, which GitHub
// Pages serves for every missing URL on the site.
export default function NotFound() {
	return (
		<main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
			<p className="font-mono text-sm text-[color:var(--fg-muted,#646a73)]">404</p>
			<h1 className="text-2xl font-bold tracking-tight">This page does not exist.</h1>
			<p className="max-w-md text-sm text-[color:var(--fg-muted,#646a73)]">
				The URL may have moved during a rebuild. Start from the home page or the docs index.
			</p>
			<div className="flex gap-4 text-sm underline underline-offset-4">
				<Link href="/">Home</Link>
				<Link href="/docs/">Docs</Link>
			</div>
		</main>
	);
}
