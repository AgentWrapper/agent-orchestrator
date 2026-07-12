"use client";

import { useEffect, useRef, useState } from "react";

const tabs = [
	{
		id: "install",
		label: "Install",
		lines: [
			"# Requires Go 1.25+, tmux on PATH",
			"$ cd backend && go build -o /tmp/ao ./cmd/ao",
			"",
			"# Start the daemon and wait for /readyz",
			"$ /tmp/ao start",
			"✓ daemon up on 127.0.0.1:3001",
			"✓ pid 4821 · ready in 184ms",
			"",
			"$ /tmp/ao doctor",
			"✓ git           found · 2.43.0",
			"✓ tmux          found · 3.5a",
			"✓ data dir      ~/.ao",
			"✓ all checks    passing",
		],
	},
	{
		id: "spawn",
		label: "Spawn agents",
		lines: [
			"# Register a local repo with worker + orchestrator",
			"$ ao project add --path /path/to/repo --id myrepo \\",
			"      --worker-agent codex \\",
			"      --orchestrator-agent claude-code",
			'✓ project "myrepo" registered',
			"",
			"# Fan a task out across parallel sessions",
			"$ ao spawn --project myrepo \\",
			'      --prompt "Refactor auth to use JWT"',
			"✓ session sess_8f2 · worktree wt-jwt",
			"",
			"$ ao session ls --project myrepo",
			"  sess_8f2  codex        wt-jwt        active",
			"  sess_a13  claude-code  wt-add-sso    active",
			"  sess_c01  cursor       wt-webhooks   active",
		],
	},
	{
		id: "ci",
		label: "Auto-nudge on CI",
		lines: [
			"# the SCM observer is already running. no flags needed.",
			"# when GitHub Actions fails:",
			"",
			'[scm/github]  PR #482 · check "lint" → fail',
			"[lcm]         derive nudge for sess_8f2",
			"[agent/codex] received nudge · resuming pane",
			"",
			"# the agent re-opens the worktree, fixes the lint,",
			"# pushes a new commit, and CI re-runs.",
			"# you do nothing.",
			"",
			'[scm/github]  PR #482 · check "lint" → pass',
			"[scm/github]  PR #482 · merged → main",
			"✓ ship it.",
		],
	},
];

function classify(line: string) {
	if (!line) return "blank";
	if (line.startsWith("✓")) return "ok";
	if (line.startsWith("$")) return "cmd";
	if (line.startsWith("#")) return "comment";
	if (line.startsWith("[")) return "log";
	return "out";
}

function CommandLines({ lines }: { lines: string[] }) {
	const colorFor = (kind: string) =>
		kind === "ok"
			? "text-[color:var(--status-ok)]"
			: kind === "cmd"
				? "text-[color:var(--code-fg)]"
				: "text-[color:var(--code-muted)]";

	return (
		<div className="min-h-[380px] font-mono text-[13px] leading-[1.8]">
			{lines.map((line, index) => (
				<div key={`${line}-${index}`} className={`${colorFor(classify(line))} whitespace-pre-wrap`}>
					{line || "\u00A0"}
				</div>
			))}
		</div>
	);
}

function CopyIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<rect width="14" height="14" x="8" y="8" rx="2" />
			<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
		</svg>
	);
}

function CheckIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="M20 6 9 17l-5-5" />
		</svg>
	);
}

async function copyText(text: string) {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Fall through to the textarea path for browsers that block Clipboard API.
		}
	}

	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.left = "-9999px";
	textarea.style.top = "0";
	document.body.appendChild(textarea);
	textarea.select();

	try {
		return document.execCommand("copy");
	} finally {
		document.body.removeChild(textarea);
	}
}

export function LandingLiveDemo() {
	const [active, setActive] = useState("install");
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
	const copyResetRef = useRef<number | null>(null);
	const current = tabs.find((tab) => tab.id === active) ?? tabs[0];

	useEffect(() => {
		return () => {
			if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
		};
	}, []);

	const onCopy = async () => {
		const copied = await copyText(current.lines.join("\n"));
		if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
		setCopyState(copied ? "copied" : "failed");
		copyResetRef.current = window.setTimeout(() => setCopyState("idle"), 1500);
	};

	return (
		<section
			id="quickstart"
			data-testid="live-demo-terminal"
			className="relative border-t border-[color:var(--border)] bg-[color:var(--bg)] py-24 sm:py-32"
		>
			<div className="container-page">
				<div className="mb-14 grid items-end gap-8 lg:grid-cols-12">
					<div className="lg:col-span-7">
						<div className="serial-num mb-3 font-mono text-xs">05 - quickstart</div>
						<h2
							className="font-display font-bold leading-[1.02] tracking-tight text-[color:var(--fg)]"
							style={{ fontSize: "clamp(32px, 4.8vw, 60px)" }}
						>
							From zero to a fleet -{" "}
							<span className="font-editorial font-medium italic text-[color:var(--accent)]">in three commands.</span>
						</h2>
					</div>
					<div className="lg:col-span-5">
						<p className="text-[15px] leading-relaxed text-[color:var(--fg-muted)]">
							Live transcript. Click a tab - the daemon types it back.
						</p>
					</div>
				</div>

				<div className="terminal-window">
					<div className="terminal-header flex items-center justify-between px-3 py-2">
						<div className="flex items-center gap-1.5">
							<span className="h-3 w-3 rounded-full bg-[color:var(--dot-red)]" />
							<span className="h-3 w-3 rounded-full bg-[color:var(--dot-yellow)]" />
							<span className="h-3 w-3 rounded-full bg-[color:var(--dot-green)]" />
						</div>
						<span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--code-muted)]">
							ao - {current.label.toLowerCase()}
						</span>
						<button
							type="button"
							onClick={onCopy}
							data-testid="demo-copy-btn"
							className="inline-flex min-w-[88px] items-center justify-center gap-1.5 rounded border border-[color:var(--border-strong)] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)] opacity-70 transition-[opacity,border-color,color,background-color] duration-150 hover:border-[color:var(--border-bright)] hover:bg-white/[0.035] hover:text-[color:var(--fg)] hover:opacity-100"
							aria-live="polite"
						>
							{copyState === "copied" ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
							{copyState === "copied" ? "Copied" : copyState === "failed" ? "Failed" : "Copy"}
						</button>
					</div>
					<div className="flex items-center gap-1 border-b border-[color:var(--border)] bg-[color:var(--code-chrome)] px-3 pt-3">
						{tabs.map((tab) => {
							const isActive = tab.id === active;
							return (
								<button
									key={tab.id}
									onClick={() => setActive(tab.id)}
									className={`-mb-px rounded-t-md border-x border-t px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] transition-[background-color,border-color,color] duration-150 ${
										isActive
											? "border-[color:var(--border-strong)] bg-[color:var(--code-bg)] text-[color:var(--code-fg)]"
											: "border-transparent text-[color:var(--code-muted)] hover:bg-white/[0.025] hover:text-[color:var(--code-fg)]"
									}`}
								>
									{tab.label}
								</button>
							);
						})}
					</div>
					<div data-testid="demo-code-block" className="min-h-[436px] bg-[color:var(--code-bg)] p-5 sm:p-7">
						<div key={active} className="landing-code-panel">
							<CommandLines lines={current.lines} />
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
