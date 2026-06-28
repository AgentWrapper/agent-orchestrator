const features = [
	{
		kicker: "the substrate",
		title: "An operating system, not a wrapper.",
		desc: "Inbound and outbound port contracts. Swappable adapters. A CDC stream. The kind of substrate that survives the next model upgrade - and the one after that.",
		visual: "ports",
		accent: true,
		span: "lg:col-span-2",
	},
	{
		kicker: "isolation",
		title: "Every agent gets a worktree.",
		desc: "No branch collisions. No stash gymnastics. Each session lives in its own git worktree with its own attachable pane.",
		visual: "branch",
		span: "lg:col-span-1",
	},
	{
		kicker: "feedback loop",
		title: "PRs watched. Agents nudged.",
		desc: "CI failure, requested change, merge conflict - the lifecycle manager routes each fact back to the owning agent automatically.",
		visual: "pr",
		span: "lg:col-span-1",
	},
	{
		kicker: "durability",
		title: "Durable facts. Derived status.",
		desc: "SQLite stores a small set of session facts. Display state is computed at read time. Triggers append to change_log; CDC fans events out via SSE.",
		visual: "log",
		span: "lg:col-span-2",
	},
	{
		kicker: "trust model",
		title: "Bound to 127.0.0.1.",
		desc: "No auth, no CORS, no TLS. No SaaS in the loop. Your threat model fits on a sticky note.",
		span: "lg:col-span-1",
	},
	{
		kicker: "lifecycle",
		title: "Lifecycle manager + reaper.",
		desc: "Reduces runtime, activity and PR observations into durable state. Crash-safe reconcile on every boot.",
		span: "lg:col-span-1",
	},
	{
		kicker: "interfaces",
		title: "ao CLI and Electron app.",
		desc: "Both drive the same daemon over loopback. Spawn from a terminal; supervise in a desktop kanban.",
		span: "lg:col-span-1",
	},
];

export function LandingFeatures() {
	return (
		<section id="features" data-testid="features-grid" className="relative py-24 sm:py-32">
			<div className="container-page">
				<div className="mb-14 grid items-end gap-8 lg:grid-cols-12">
					<div className="lg:col-span-7">
						<div className="serial-num mb-3 font-mono text-xs">02 - what&apos;s inside</div>
						<h2
							className="font-display font-bold leading-[1.05] tracking-tight text-[color:var(--fg)]"
							style={{ fontSize: "clamp(32px, 4.5vw, 56px)" }}
						>
							Built like an operating system,{" "}
							<span className="font-editorial font-medium italic text-[color:var(--fg-muted)]">not a wrapper.</span>
						</h2>
					</div>
					<div className="lg:col-span-5">
						<p className="text-[15px] leading-relaxed text-[color:var(--fg-muted)]">
							Inbound/outbound port contracts. Swappable adapters. A CDC stream - the kind of substrate that survives
							the next model upgrade. And the one after that.
						</p>
					</div>
				</div>

				<div className="grid gap-4 lg:grid-cols-3">
					{features.map((feature, i) => (
						<FeatureCard key={feature.title} feature={feature} index={i} />
					))}
				</div>
			</div>
		</section>
	);
}

function FeatureCard({ feature, index }: { feature: (typeof features)[number]; index: number }) {
	return (
		<article
			data-testid={`feature-article-${String(index + 1).padStart(2, "0")}`}
			className={`surface lift group relative overflow-hidden p-6 ${feature.span || ""} ${
				feature.accent ? "bg-gradient-to-br from-[color:var(--bg-card)] to-[#0d1220]" : ""
			}`}
		>
			<div className="mb-5 flex items-center gap-2">
				<div
					className={`flex h-8 w-8 items-center justify-center rounded-md border font-mono text-xs ${
						feature.accent
							? "border-[color:var(--accent)] bg-[color:var(--accent-soft)] text-[color:var(--accent)]"
							: "border-[color:var(--border-strong)] bg-[color:var(--bg-deep)] text-[color:var(--fg-muted)]"
					}`}
				>
					{String(index + 1).padStart(2, "0")}
				</div>
				<span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--fg-dim)]">
					{feature.kicker}
				</span>
			</div>
			<h3 className="font-display mb-2.5 text-[19px] font-bold leading-snug tracking-tight text-[color:var(--fg)] sm:text-[21px]">
				{feature.title}
			</h3>
			<p className="text-[14px] leading-relaxed text-[color:var(--fg-muted)]">{feature.desc}</p>
			{feature.visual === "ports" && <PortsVisual />}
			{feature.visual === "branch" && <BranchVisual />}
			{feature.visual === "pr" && <PrVisual />}
			{feature.visual === "log" && <LogVisual />}
		</article>
	);
}

function PortsVisual() {
	return (
		<div className="mt-6 grid grid-cols-3 gap-2 border-t border-[color:var(--border)] pt-5">
			{["Agent", "Runtime", "Workspace", "SCM", "Tracker", "Reviewer"].map((port, i) => (
				<div
					key={port}
					className="flex items-center gap-1.5 py-1 font-mono text-[10px] uppercase tracking-wider text-[color:var(--fg-muted)]"
				>
					<span className="h-1 w-1 rounded-full" style={{ background: i === 0 ? "var(--accent)" : "var(--fg-dim)" }} />
					{port}
				</div>
			))}
		</div>
	);
}

function BranchVisual() {
	return (
		<svg viewBox="0 0 200 60" className="mt-5 h-auto w-full opacity-90">
			<path d="M10 30 L60 30" stroke="rgba(255,255,255,0.25)" strokeWidth="1.5" fill="none" />
			<path d="M60 30 L60 10 L190 10" stroke="var(--accent)" strokeWidth="1.5" fill="none" />
			<path d="M60 30 L190 30" stroke="rgba(255,255,255,0.25)" strokeWidth="1.5" fill="none" />
			<path d="M60 30 L60 50 L190 50" stroke="var(--accent)" strokeWidth="1.5" fill="none" />
			<circle cx="10" cy="30" r="3" fill="var(--fg-muted)" />
			<circle cx="60" cy="30" r="3" fill="var(--fg)" />
			<circle cx="190" cy="10" r="3.5" fill="var(--accent)" />
			<circle cx="190" cy="30" r="3.5" fill="var(--fg-muted)" />
			<circle cx="190" cy="50" r="3.5" fill="var(--accent)" />
		</svg>
	);
}

function PrVisual() {
	return (
		<div className="mt-5 space-y-1 font-mono text-[11px]">
			<Row color="var(--status-ok)" label="lint" status="pass" />
			<Row color="var(--status-ok)" label="unit" status="pass" />
			<Row color="var(--status-fail)" label="e2e" status="fail" highlight />
			<Row color="var(--fg-muted)" label="review" status="requested" />
			<div className="mt-2 border-t border-[color:var(--border)] pt-2 text-[10px] uppercase tracking-wider text-[color:var(--accent)]">
				-&gt; nudge -&gt; sess_8f2
			</div>
		</div>
	);
}

function Row({
	color,
	label,
	status,
	highlight,
}: {
	color: string;
	label: string;
	status: string;
	highlight?: boolean;
}) {
	return (
		<div className="flex items-center justify-between">
			<span className="flex items-center gap-1.5 text-[color:var(--fg)]">
				<span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
				{label}
			</span>
			<span
				className="text-[10px] uppercase tracking-wider"
				style={{ color: highlight ? "var(--status-fail)" : "var(--fg-muted)" }}
			>
				{status}
			</span>
		</div>
	);
}

function LogVisual() {
	return (
		<div className="mt-5 space-y-0.5 font-mono text-[11px]">
			{[
				["0x1f", "sess.spawn", "var(--fg-muted)"],
				["0x20", "pr.opened", "var(--fg-muted)"],
				["0x21", "ci.fail -> nudge", "var(--status-fail)"],
				["0x22", "agent.resume", "var(--fg-muted)"],
				["0x23", "pr.merged", "var(--status-ok)"],
			].map(([hex, label, color]) => (
				<div key={hex} className="flex justify-between">
					<span style={{ color }}>{label}</span>
					<span className="text-[color:var(--fg-dim)]">{hex}</span>
				</div>
			))}
		</div>
	);
}
