const steps = [
	{
		n: "01",
		label: "register",
		title: "Tell ao about your repo",
		desc: "Point the daemon at a local git repo. Worker and orchestrator agents are picked per project - no global setting wars.",
		code: `ao project add --path . \\
  --worker-agent codex \\
  --orchestrator-agent claude-code`,
		out: `ok project "your-repo" registered
ok data dir -> ~/.ao/`,
	},
	{
		n: "02",
		label: "spawn",
		title: "Carve out a worktree, attach a pane",
		desc: "Every spawn creates its own git worktree and an attachable runtime session. Multiple sessions, zero collisions.",
		code: `ao spawn --project your-repo --prompt \\
  "Add SSO via Okta to /auth"`,
		out: `ok session sess_8f2 spawned
ok worktree wt-add-sso-okta
ok pane attached · streaming activity`,
	},
	{
		n: "03",
		label: "ship",
		title: "Agent pushes the PR. You go for coffee.",
		desc: "The agent develops, tests, and opens a PR from inside its worktree. Activity streams back to your terminal or the desktop app.",
		code: `git push -u origin add-sso-okta
gh pr create --fill`,
		out: `PR #482 opened
checks: queued · 0/4 complete`,
	},
	{
		n: "04",
		label: "react",
		title: "Feedback routes itself",
		desc: "The SCM observer watches the PR. CI failure, requested change, merge conflict - all become nudges to the owning agent.",
		code: `[scm/github]  PR #482 · lint -> fail
[lcm]         derive nudge for sess_8f2
[agent/codex] received nudge · fix in progress`,
		out: `ok lint passing · pushed fixup
ok pr.merged -> main`,
		accent: true,
	},
];

export function LandingHowItWorks() {
	return (
		<section
			id="how"
			data-testid="how-it-works"
			className="relative border-t border-[color:var(--border)] bg-[color:var(--bg)] py-24 sm:py-32"
		>
			<div className="container-page">
				<div className="mb-14 grid items-end gap-8 lg:grid-cols-12">
					<div className="lg:col-span-7">
						<div className="serial-num mb-3 font-mono text-xs">03 - how it works</div>
						<h2
							className="font-display font-bold leading-[1.02] tracking-tight text-[color:var(--fg)]"
							style={{ fontSize: "clamp(32px, 4.8vw, 60px)" }}
						>
							Four commands.{" "}
							<span className="font-editorial font-medium italic text-[color:var(--accent)]">A fleet at work.</span>
						</h2>
					</div>
					<div className="lg:col-span-5">
						<p className="text-[15px] leading-relaxed text-[color:var(--fg-muted)]">
							No control plane. No SaaS account. No Docker network to debug. One Go binary, your favorite agent CLI, and
							the orchestrator runs on loopback.
						</p>
					</div>
				</div>

				<div className="relative space-y-5 lg:space-y-0">
					{steps.map((step, i) => (
						<Step key={step.n} step={step} index={i} />
					))}
				</div>
			</div>
		</section>
	);
}

function Step({ step, index }: { step: (typeof steps)[number]; index: number }) {
	return (
		<article
			data-testid={`step-${step.n}`}
			style={{ top: `calc(88px + ${index * 18}px)`, zIndex: 10 + index }}
			className={`surface grid overflow-hidden lg:sticky lg:mb-6 lg:grid-cols-12 ${step.accent ? "glow-accent" : ""}`}
		>
			<div className="border-b border-[color:var(--border)] p-6 sm:p-8 lg:col-span-5 lg:border-b-0 lg:border-r">
				<div className="mb-4 flex items-center gap-3">
					<span className="font-mono text-[11px] uppercase tracking-[0.25em] text-[color:var(--fg-dim)]">
						step {step.n}
					</span>
					<span className="h-px flex-1 bg-[color:var(--border)]" />
					<span
						className={`inline-block rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.22em] ${
							step.accent
								? "bg-[color:var(--accent-soft)] text-[color:var(--accent)]"
								: "border border-[color:var(--border-strong)] bg-[color:var(--bg-deep)] text-[color:var(--fg-muted)]"
						}`}
					>
						{step.label}
					</span>
				</div>
				<h3 className="font-display mb-3 text-[22px] font-bold leading-tight tracking-tight text-[color:var(--fg)] sm:text-[26px]">
					{step.title}
				</h3>
				<p className="text-[14.5px] leading-relaxed text-[color:var(--fg-muted)]">{step.desc}</p>
			</div>

			<div className="border-l border-[color:var(--border)] bg-[color:var(--code-bg)] p-6 font-mono text-[12.5px] leading-relaxed sm:p-8 lg:col-span-7">
				<div className="mb-3 flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-[color:var(--code-muted)]">
					<span className="h-1.5 w-1.5 rounded-full bg-[color:var(--accent)]" />
					<span>~/projects/your-repo</span>
					<span className="ml-auto">{step.label}.sh</span>
				</div>
				<pre className="whitespace-pre-wrap break-words text-[color:var(--code-fg)]">{step.code}</pre>
				<div className="mt-3 border-t border-[color:var(--border)] pt-3 text-[color:var(--code-muted)]">
					<pre className="whitespace-pre-wrap break-words">{step.out}</pre>
				</div>
			</div>
		</article>
	);
}
