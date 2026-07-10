const ports = [
	{ name: "Agent", impls: "claude-code · codex · cursor · +20", accent: true },
	{ name: "Runtime", impls: "tmux · process · conpty" },
	{ name: "Workspace", impls: "git worktree" },
	{ name: "SCM", impls: "GitHub" },
	{ name: "Tracker", impls: "GitHub", muted: true },
	{ name: "Reviewer", impls: "claude-code" },
];

export function LandingArchitecture() {
	return (
		<section
			id="architecture"
			data-testid="architecture-diagram"
			className="relative border-t border-[color:var(--border)] py-24 sm:py-32"
		>
			<div className="container-page">
				<div className="mb-14 grid items-end gap-8 lg:grid-cols-12">
					<div className="lg:col-span-7">
						<div className="serial-num mb-3 font-mono text-xs">04 - architecture</div>
						<h2
							className="font-display font-bold leading-[1.02] tracking-tight text-[color:var(--fg)]"
							style={{ fontSize: "clamp(32px, 4.8vw, 60px)" }}
						>
							A daemon at the center.{" "}
							<span className="font-editorial font-medium italic text-[color:var(--accent)]">Ports at the edges.</span>
						</h2>
					</div>
					<div className="lg:col-span-5">
						<p className="text-[15px] leading-relaxed text-[color:var(--fg-muted)]">
							Hexagonal architecture. Inbound/outbound port contracts make every external system - agent, runtime,
							workspace, SCM - a swappable adapter.
						</p>
					</div>
				</div>

				<div className="surface relative overflow-hidden">
					<div className="dotgrid relative px-6 py-12 sm:px-10 sm:py-16">
						<div className="mb-8 flex flex-wrap justify-center gap-6 sm:gap-12">
							<ClientNode label="ao CLI" sub="thin daemon client" />
							<ClientNode label="Electron app" sub="desktop supervisor" />
						</div>
						<Wires variant="clients" />
						<div className="mb-10 flex justify-center">
							<div className="relative">
								<div className="absolute -inset-px rounded-xl bg-gradient-to-br from-[color:var(--accent)] to-transparent opacity-40 blur-sm" />
								<div className="glow-accent relative rounded-xl border border-[color:var(--accent)] bg-[color:var(--bg-deep)] px-8 py-6 text-[color:var(--fg)] sm:px-14 sm:py-8">
									<div className="mb-2 flex items-center gap-2">
										<span className="pulse-dot h-1.5 w-1.5 rounded-full bg-[color:var(--accent)]" />
										<span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--accent)]">
											127.0.0.1 · loopback only
										</span>
									</div>
									<div className="font-display text-3xl font-bold tracking-tight sm:text-4xl">Go daemon</div>
									<div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
										{["HTTP API", "Lifecycle mgr", "CDC stream", "SQLite store"].map((item) => (
											<div
												key={item}
												className="rounded border border-[color:var(--border-strong)] bg-[color:var(--bg-card)] px-2.5 py-1.5 text-center font-mono text-[10px] uppercase tracking-wider text-[color:var(--fg-muted)]"
											>
												{item}
											</div>
										))}
									</div>
								</div>
							</div>
						</div>
						<Wires variant="ports" />
						<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
							{ports.map((port) => (
								<Port key={port.name} port={port} />
							))}
						</div>
					</div>
					<div className="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--border)] bg-[color:var(--bg-chrome)] px-6 py-4 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--fg-dim)] sm:px-10">
						<span>
							<span className="text-[color:var(--fg-muted)]">ports/</span> backend/internal/ports/
						</span>
						<span>
							<span className="text-[color:var(--fg-muted)]">adapters/</span> registered at boot
						</span>
						<span>
							<span className="text-[color:var(--fg-muted)]">events/</span> sse fan-out
						</span>
					</div>
				</div>
			</div>
		</section>
	);
}

function ClientNode({ label, sub }: { label: string; sub: string }) {
	return (
		<div className="text-center">
			<div className="surface-elev lift inline-block px-6 py-3">
				<div className="font-display text-lg font-bold tracking-tight text-[color:var(--fg)]">{label}</div>
			</div>
			<div className="mt-2 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--fg-dim)]">{sub}</div>
		</div>
	);
}

function Port({ port }: { port: (typeof ports)[number] }) {
	return (
		<div
			className={`surface lift px-3 py-3 ${port.muted ? "opacity-60" : ""} ${port.accent ? "border-[color:var(--accent)]" : ""}`}
		>
			<div className="mb-1 flex items-center gap-1.5">
				<span
					className="h-1 w-1 rounded-full"
					style={{ background: port.accent ? "var(--accent)" : "var(--fg-dim)" }}
				/>
				<span className="font-mono text-[9px] uppercase tracking-[0.22em] text-[color:var(--fg-dim)]">port</span>
			</div>
			<div className="font-display text-[15px] font-bold tracking-tight text-[color:var(--fg)]">{port.name}</div>
			<div className="mt-1 font-mono text-[10px] leading-snug text-[color:var(--fg-muted)]">{port.impls}</div>
		</div>
	);
}

function Wires({ variant }: { variant: "clients" | "ports" }) {
	const paths =
		variant === "clients"
			? ["M260 0 L300 60", "M340 0 L300 60"]
			: ["M300 0 L80 60", "M300 0 L200 60", "M300 0 L300 60", "M300 0 L400 60", "M300 0 L520 60"];
	return (
		<div className="relative mb-2 flex h-12 justify-center sm:h-16">
			<svg viewBox="0 0 600 60" className="h-full w-full max-w-[760px]">
				{paths.map((d, i) => (
					<g key={d}>
						<path d={d} stroke="var(--wire)" strokeWidth="1.4" fill="none" />
						<path
							d={d}
							stroke="var(--accent)"
							strokeWidth="1.8"
							fill="none"
							strokeDasharray="16 200"
							style={{ animation: `wire-pulse 2.6s ease-in-out ${i * 0.3}s infinite` }}
						/>
					</g>
				))}
			</svg>
		</div>
	);
}
