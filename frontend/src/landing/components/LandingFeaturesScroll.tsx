"use client";

import { type ReactNode, useEffect, useMemo, useState, useRef } from "react";
import gsap from "gsap";
import ScrollTrigger from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { ScaledMockup } from "./ScaledMockup";

if (typeof window !== "undefined") {
	gsap.registerPlugin(ScrollTrigger, useGSAP);
}

type AgentHarness = {
	id: string;
	name: string;
	org: string;
	logo?: string;
	command: string;
	delivery: string;
	restore: string;
	hooks: string;
};

const primaryAgents: AgentHarness[] = [
	{
		id: "claude-code",
		name: "Claude Code",
		org: "Anthropic",
		logo: "/docs/logos/claude-code.svg",
		command: "claude --append-system-prompt-file .ao/AGENTS.md",
		delivery: "native CLI launch",
		restore: "resume supported",
		hooks: "workspace hooks",
	},
	{
		id: "codex",
		name: "Codex",
		org: "OpenAI",
		logo: "/docs/logos/codex.svg",
		command: "codex --config ao.session=session/ao-204",
		delivery: "session flags",
		restore: "codex resume",
		hooks: "session flags",
	},
	{
		id: "opencode",
		name: "OpenCode",
		org: "OpenCode",
		logo: "/docs/logos/opencode.svg",
		command: "opencode run --session session/ao-204",
		delivery: "terminal agent",
		restore: "session API",
		hooks: "activity bridge",
	},
	{
		id: "aider",
		name: "Aider",
		org: "Aider",
		logo: "/docs/logos/aider.png",
		command: "aider --message-file .ao/prompt.md",
		delivery: "prompt file",
		restore: "supported",
		hooks: "PATH wrappers",
	},
	{
		id: "cursor",
		name: "Cursor",
		org: "Cursor",
		logo: "/docs/logos/cursor.svg",
		command: "cursor-agent --print --force",
		delivery: "one-shot CLI",
		restore: "fresh launch",
		hooks: "terminal activity",
	},
	{
		id: "goose",
		name: "Goose",
		org: "Block",
		logo: "https://www.google.com/s2/favicons?domain=goose-docs.ai&sz=64",
		command: "goose run --resume --session-id ao-204",
		delivery: "native CLI launch",
		restore: "session id",
		hooks: "workspace hooks",
	},
];

const workspaceSessions = [
	{
		id: "ao-204",
		title: "Split terminal mux responsibilities",
		agent: "Claude Code",
		branch: "session/ao-204",
		path: ".ao/worktrees/ao-204",
		status: "working",
		color: "#f59f4c",
		files: ["backend/internal/terminal/manager.go", "frontend/src/renderer/components/TerminalPane.tsx"],
	},
	{
		id: "int-8",
		title: "fix auth timeout retry loop",
		agent: "Codex",
		branch: "fix/auth-timeouts",
		path: ".ao/worktrees/int-8",
		status: "ci failed",
		color: "#ff6b73",
		files: ["backend/internal/httpd/auth.go", "backend/internal/session_manager/restore.go"],
	},
	{
		id: "ao-211",
		title: "publish linux desktop install path",
		agent: "Aider",
		branch: "docs/linux-install",
		path: ".ao/worktrees/ao-211",
		status: "approved",
		color: "#6ee79a",
		files: ["frontend/src/landing/content/docs/installation.mdx", "README.md"],
	},
];

const feedbackSessions = [
	{
		id: "pr-184",
		number: "#184",
		title: "fix auth timeout retry loop",
		agent: "Codex",
		branch: "fix/auth-timeouts",
		session: "int-8",
		state: "needs you",
		color: "#ff6b73",
		checks: [
			{ name: "lint", state: "passed", color: "#6ee79a" },
			{ name: "unit", state: "passed", color: "#6ee79a" },
			{ name: "e2e", state: "failed", color: "#ff6b73" },
		],
		comments: ["Auth retry leaks stale token after timeout", "Add regression coverage for 401 retry path"],
		nudge: "CI failed on PR #184. Fix auth retry timeout and push an update.",
	},
	{
		id: "pr-185",
		number: "#185",
		title: "add rate limit headers",
		agent: "OpenCode",
		branch: "feat/rate-limit-headers",
		session: "ao-185",
		state: "in review",
		color: "#93b4f8",
		checks: [
			{ name: "lint", state: "passed", color: "#6ee79a" },
			{ name: "unit", state: "passed", color: "#6ee79a" },
			{ name: "review", state: "pending", color: "#93b4f8" },
		],
		comments: ["Reviewer asked for header docs", "Open question on retry-after semantics"],
		nudge: "Review comments landed on PR #185. Address docs and retry-after behavior.",
	},
	{
		id: "pr-204",
		number: "#204",
		title: "Build onboarding test for published npm package",
		agent: "Cursor",
		branch: "test/onboarding-harness",
		session: "ao-204",
		state: "ready to merge",
		color: "#6ee79a",
		checks: [
			{ name: "lint", state: "passed", color: "#6ee79a" },
			{ name: "unit", state: "passed", color: "#6ee79a" },
			{ name: "review", state: "approved", color: "#6ee79a" },
		],
		comments: ["Approved with two reviews", "Mergeability clean"],
		nudge: "PR #204 is approved and mergeable. Ready for final merge.",
	},
];

const daemonChecks = [
	{ label: "daemon", value: "ready on 127.0.0.1:3001", state: "ok" },
	{ label: "database", value: "~/.ao/data/ao.sqlite", state: "ok" },
	{ label: "git", value: "available", state: "ok" },
	{ label: "runtime", value: "tmux detected", state: "ok" },
];

const FEATURE_META = [
	{ eyebrow: "Agent harness", title: "Bring your own agent.", accent: "AO gives it a workflow." },
	{ eyebrow: "Worktrees", title: "Every task gets its own checkout.", accent: "Your main repo stays clean." },
	{ eyebrow: "Review routing", title: "Reviews route back to the owner.", accent: "Not to a random terminal." },
	{ eyebrow: "Local daemon", title: "Desktop and CLI share one brain.", accent: "A local daemon owns the loop." },
];

/** Pi.dev-style pinned scroll: mockup starts centered, shifts right as text reveals, then steps through features. */
const INTRO_RATIO = 0.22;
const FEATURE_COUNT = FEATURE_META.length;

export function LandingFeaturesScroll() {
	const [workerId, setWorkerId] = useState("codex");
	const [orchestratorId, setOrchestratorId] = useState("claude-code");
	const [workspaceId, setWorkspaceId] = useState("int-8");
	const [feedbackId, setFeedbackId] = useState("pr-184");
	const [active, setActive] = useState(0);
	const [introComplete, setIntroComplete] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const pinRef = useRef<HTMLDivElement>(null);
	const textColRef = useRef<HTMLDivElement>(null);
	const mockColRef = useRef<HTMLDivElement>(null);
	const dotsRef = useRef<HTMLDivElement>(null);
	const activeRef = useRef(0);
	const introCompleteRef = useRef(false);
	const prevActiveRef = useRef(-1);

	const worker = useMemo(() => primaryAgents.find((agent) => agent.id === workerId) ?? primaryAgents[0], [workerId]);
	const orchestrator = useMemo(
		() => primaryAgents.find((agent) => agent.id === orchestratorId) ?? primaryAgents[0],
		[orchestratorId],
	);
	const workspace = useMemo(
		() => workspaceSessions.find((session) => session.id === workspaceId) ?? workspaceSessions[0],
		[workspaceId],
	);
	const feedback = useMemo(
		() => feedbackSessions.find((session) => session.id === feedbackId) ?? feedbackSessions[0],
		[feedbackId],
	);

	useGSAP(
		() => {
			// Desktop: pin while the mockup travels center → right, text fades in, then
			// each feature crossfades. Mobile renders the features stacked.
			const mm = gsap.matchMedia();

			mm.add("(min-width: 1024px)", () => {
				const textCol = textColRef.current;
				const mockCol = mockColRef.current;
				const dots = dotsRef.current;

				if (textCol) gsap.set(textCol, { opacity: 0, x: -56, pointerEvents: "none" });
				if (mockCol) gsap.set(mockCol, { left: "50%", right: "auto", xPercent: -50, yPercent: -50, top: "50%" });
				if (dots) gsap.set(dots, { opacity: 0, y: 12 });

				const snapPoints = [
					0,
					INTRO_RATIO,
					...Array.from({ length: FEATURE_COUNT - 1 }, (_, i) => {
						const featureSpan = 1 - INTRO_RATIO;
						return INTRO_RATIO + (featureSpan * (i + 1)) / (FEATURE_COUNT - 1);
					}),
				];

				const st = ScrollTrigger.create({
					trigger: pinRef.current,
					pin: true,
					start: "top top",
					end: () => "+=" + window.innerHeight * 3.4,
					anticipatePin: 1,
					invalidateOnRefresh: true,
					scrub: 0.35,
					snap: {
						snapTo: snapPoints,
						duration: { min: 0.28, max: 0.55 },
						delay: 0.04,
						ease: "power2.inOut",
					},
					onUpdate: (self) => {
						const p = self.progress;
						const introT = Math.min(1, p / INTRO_RATIO);
						const easedIntro = gsap.parseEase("power3.out")(introT);

						if (textCol) {
							gsap.set(textCol, {
								opacity: easedIntro,
								x: (1 - easedIntro) * -56,
								pointerEvents: easedIntro > 0.45 ? "auto" : "none",
							});
						}

						if (mockCol) {
							const scale = gsap.utils.interpolate(1.02, 1, easedIntro);
							if (easedIntro >= 0.999) {
								gsap.set(mockCol, {
									left: "auto",
									right: 0,
									xPercent: 0,
									yPercent: -50,
									top: "50%",
									scale: 1,
								});
							} else {
								const leftPct = gsap.utils.interpolate(50, 44, easedIntro);
								const xPct = gsap.utils.interpolate(-50, 0, easedIntro);
								gsap.set(mockCol, {
									left: `${leftPct}%`,
									right: "auto",
									xPercent: xPct,
									yPercent: -50,
									top: "50%",
									scale,
								});
							}
						}

						if (dots) {
							gsap.set(dots, { opacity: easedIntro, y: (1 - easedIntro) * 12 });
						}

						const introDone = p >= INTRO_RATIO - 0.001;
						if (introDone !== introCompleteRef.current) {
							introCompleteRef.current = introDone;
							setIntroComplete(introDone);
						}

						if (p < INTRO_RATIO) {
							if (activeRef.current !== 0) {
								activeRef.current = 0;
								setActive(0);
							}
							return;
						}

						const featureSpan = 1 - INTRO_RATIO;
						const fp = (p - INTRO_RATIO) / featureSpan;
						const idx = Math.min(FEATURE_COUNT - 1, Math.round(fp * (FEATURE_COUNT - 1)));
						if (idx !== activeRef.current) {
							activeRef.current = idx;
							setActive(idx);
						}
					},
				});

				return () => st.kill();
			});

			return () => mm.revert();
		},
		{ scope: containerRef },
	);

	// Fluid swap between features: outgoing fades out while the incoming text
	// rises line-by-line and the mockup settles in with a soft scale. Runs on
	// active change; the first run just reveals the initial panel without animating.
	useEffect(() => {
		const root = pinRef.current;
		if (!root) return;

		const panels = Array.from(root.querySelectorAll<HTMLElement>(".fp-panel"));
		const mocks = Array.from(root.querySelectorAll<HTMLElement>(".fp-mock"));
		const prev = prevActiveRef.current;
		const first = prev === -1;
		prevActiveRef.current = active;

		panels.forEach((panel, i) => {
			const items = panel.querySelectorAll<HTMLElement>(".swap-item");
			if (i === active) {
				gsap.set(panel, { opacity: 1, pointerEvents: "auto", zIndex: 2 });
				if (first) {
					gsap.set(items, { y: 0, opacity: 1 });
				} else {
					gsap.fromTo(
						items,
						{ y: 34, opacity: 0 },
						{ y: 0, opacity: 1, duration: 0.8, stagger: 0.09, ease: "power4.out", overwrite: true },
					);
				}
			} else {
				gsap.set(panel, { pointerEvents: "none", zIndex: 1 });
				if (i === prev) gsap.to(panel, { opacity: 0, duration: 0.35, ease: "power2.in", overwrite: true });
				else gsap.set(panel, { opacity: 0 });
			}
		});

		mocks.forEach((mock, i) => {
			if (i === active) {
				gsap.set(mock, { pointerEvents: "auto", zIndex: 2 });
				if (first) {
					gsap.set(mock, { opacity: 1, scale: 1, y: 0 });
				} else {
					gsap.fromTo(
						mock,
						{ opacity: 0, scale: 1.05, y: 22 },
						{ opacity: 1, scale: 1, y: 0, duration: 0.85, ease: "power3.out", overwrite: true },
					);
				}
			} else {
				gsap.set(mock, { pointerEvents: "none", zIndex: 1 });
				if (i === prev) gsap.to(mock, { opacity: 0, scale: 0.97, duration: 0.4, ease: "power2.in", overwrite: true });
				else gsap.set(mock, { opacity: 0, scale: 1 });
			}
		});
	}, [active]);

	// Each mockup is described once and rendered in both layouts (desktop pinned
	// crossfade + mobile stacked). React makes an independent instance per slot.
	const mockups = [
		<AgentHarnessDemo
			key="harness"
			worker={worker}
			orchestrator={orchestrator}
			workerId={workerId}
			orchestratorId={orchestratorId}
			onWorkerChange={setWorkerId}
			onOrchestratorChange={setOrchestratorId}
		/>,
		<WorkspaceIsolationDemo key="workspace" activeId={workspaceId} onSelect={setWorkspaceId} workspace={workspace} />,
		<FeedbackRoutingDemo key="feedback" activeId={feedbackId} onSelect={setFeedbackId} feedback={feedback} />,
		<DaemonControlDemo key="daemon" />,
	];
	const panels = [
		<FeatureNarrative key="harness" worker={worker} orchestrator={orchestrator} />,
		<WorkspaceNarrative key="workspace" workspace={workspace} />,
		<FeedbackNarrative key="feedback" feedback={feedback} />,
		<DaemonNarrative key="daemon" />,
	];

	return (
		<section ref={containerRef} id="features" data-testid="features-scroll" className="relative">
			{/* Desktop: pinned pi-style scroll — mockup centered first, shifts right as text appears. */}
			<div ref={pinRef} className="relative hidden h-screen overflow-hidden lg:block">
				<div className="container-page flex h-full w-full flex-col pt-17">
					<div className="flex shrink-0 items-center gap-4 px-1 pb-0">
						<div className="h-px flex-1 bg-gradient-to-r from-transparent via-[color:var(--border-strong)] to-[color:var(--border-strong)]" />
						<div className="whitespace-nowrap text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--fg-dim)]">
							FEATURES
						</div>
						<div className="h-px flex-1 bg-gradient-to-r from-[color:var(--border-strong)] via-[color:var(--border-strong)] to-transparent" />
					</div>

					<div className="relative min-h-0 flex-1">
						<div
							ref={textColRef}
							className="fp-text-col absolute inset-y-0 left-0 z-10 flex w-[44%] max-w-[44%] items-center pr-6 xl:pr-10 pb-20"
							aria-hidden={!introComplete && active === 0}
						>
							<div className="relative min-h-[460px] w-full">
								{panels.map((panel, i) => (
									<div
										key={i}
										aria-hidden={i !== active}
										className="fp-panel absolute inset-0 flex flex-col justify-center will-change-[opacity,transform]"
									>
										{panel}
									</div>
								))}
							</div>
						</div>

						<div
							ref={mockColRef}
							className="fp-mock-col absolute top-1/2 z-10 h-[min(560px,72vh)] w-[56%] max-w-[56%] will-change-transform"
						>
							{mockups.map((mockup, i) => (
								<div
									key={i}
									aria-hidden={i !== active}
									className="fp-mock absolute inset-0 flex items-center justify-center will-change-[opacity,transform]"
								>
									{mockup}
								</div>
							))}
						</div>

						<div
							ref={dotsRef}
							className="absolute bottom-40 left-0 z-50 flex items-center gap-2"
							aria-label="Feature progress"
						>
							{FEATURE_META.map((meta, i) => (
								<span
									key={meta.eyebrow}
									className={`h-1.5 rounded-full transition-all duration-400 ${
										i === active ? "w-8 bg-[color:var(--accent)]" : "w-1.5 bg-[color:var(--border-strong)]"
									}`}
								/>
							))}
						</div>
					</div>
				</div>
			</div>

			{/* Mobile / tablet: simple stacked list, each with its own scaled mockup. */}
			<div className="container-page pt-8 pb-16 lg:hidden">
				<div className="gsap-reveal mx-auto flex max-w-[1200px] items-center gap-4 px-1 text-left">
					<div className="h-px flex-1 bg-gradient-to-r from-transparent via-[color:var(--border-strong)] to-[color:var(--border-strong)]" />
					<div className="whitespace-nowrap text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--fg-dim)]">
						FEATURES
					</div>
					<div className="h-px flex-1 bg-gradient-to-r from-[color:var(--border-strong)] via-[color:var(--border-strong)] to-transparent" />
				</div>

				<div className="mt-8 flex flex-col gap-20">
					{panels.map((panel, i) => (
						<div key={i}>
							{panel}
							<MobileMockup>{mockups[i]}</MobileMockup>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}

function MobileMockup({ children }: { children: ReactNode }) {
	return (
		<div className="mt-7 lg:hidden">
			<ScaledMockup designWidth={600}>{children}</ScaledMockup>
		</div>
	);
}

function FeatureNarrative({ worker, orchestrator }: { worker: AgentHarness; orchestrator: AgentHarness }) {
	return (
		<FeatureCopy
			eyebrow="Agent harness"
			title="Bring your own agent."
			accent="AO gives it a workflow."
			meta="23 harnesses"
		>
			<p>
				Run <FeatureStrong>{worker.name}</FeatureStrong>, <FeatureStrong>{orchestrator.name}</FeatureStrong>, Cursor, or
				Aider unchanged. AO standardizes the workflow around them -{" "}
				<FeatureStrong>restore, prompts, hooks, and ownership</FeatureStrong> - so you can pick one agent to write and
				another to supervise.
			</p>
		</FeatureCopy>
	);
}

function AgentHarnessDemo({
	worker,
	orchestrator,
	workerId,
	orchestratorId,
	onWorkerChange,
	onOrchestratorChange,
}: {
	worker: AgentHarness;
	orchestrator: AgentHarness;
	workerId: string;
	orchestratorId: string;
	onWorkerChange: (id: string) => void;
	onOrchestratorChange: (id: string) => void;
}) {
	const [targetSlot, setTargetSlot] = useState<"worker" | "orchestrator">("worker");
	const visibleAgents = primaryAgents.filter((agent) => ["claude-code", "codex", "cursor", "goose"].includes(agent.id));

	return (
		<article className="surface relative w-full overflow-hidden p-0 lg:h-[520px]">
			<div className="landing-card-header flex items-center justify-between px-5 py-3.5">
				<div className="flex items-center gap-3">
					<img src="/ao-logo-transparent.png" alt="" className="h-7 w-7 object-contain" />
					<div>
						<div className="text-sm font-semibold text-[color:var(--fg)]">Project agents</div>
						<div className="font-mono text-[11px] text-[color:var(--fg-dim)]">/repo/agent-orchestrator</div>
					</div>
				</div>
				<div className="hidden rounded-full border border-[color:var(--border)] bg-white/[0.03] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[color:var(--fg-dim)] sm:block">
					adapter
				</div>
			</div>

			<div className="grid gap-0 lg:h-[calc(520px-69px)] lg:grid-cols-[0.68fr_1fr]">
				<div className="flex min-h-0 flex-col border-b border-[color:var(--border)] p-4 lg:border-b-0 lg:border-r">
					<div className="mb-3 grid gap-2 sm:grid-cols-2">
						<AgentSelectLabel
							label="Worker"
							agent={worker}
							active={targetSlot === "worker"}
							onClick={() => setTargetSlot("worker")}
						/>
						<AgentSelectLabel
							label="Orchestrator"
							agent={orchestrator}
							active={targetSlot === "orchestrator"}
							onClick={() => setTargetSlot("orchestrator")}
						/>
					</div>

					<div className="grid grid-cols-2 gap-2">
						{visibleAgents.map((agent) => (
							<button
								key={agent.id}
								type="button"
								onClick={() => {
									setTargetSlot("worker");
									onWorkerChange(agent.id);
								}}
								onDoubleClick={() => {
									setTargetSlot("orchestrator");
									onOrchestratorChange(agent.id);
								}}
								className={`group relative flex min-h-[64px] cursor-pointer flex-col items-start justify-between overflow-hidden rounded-md border p-2.5 text-left transition duration-200 ease-out hover:-translate-y-0.5 hover:border-white/15 hover:bg-white/[0.045] ${
									workerId === agent.id
										? "border-white/18 bg-white/[0.055]"
										: "border-[color:var(--border)] bg-white/[0.025]"
								}`}
								aria-pressed={workerId === agent.id}
							>
								<div className="flex w-full items-center justify-between gap-2">
									<AgentLogo agent={agent} className="h-5 w-5" />
									<span className="font-mono text-[9px] uppercase tracking-[0.16em] text-[color:var(--fg-dim)]">
										{agent.restore.includes("fresh") ? "new" : "resume"}
									</span>
								</div>
								<div>
									<div className="text-[12px] font-semibold leading-tight text-[color:var(--fg)]">{agent.name}</div>
									<div className="mt-0.5 font-mono text-[10px] text-[color:var(--fg-dim)]">{agent.org}</div>
								</div>
							</button>
						))}
					</div>

					<div className="mt-auto pt-3 text-[12px] leading-relaxed text-[color:var(--fg-dim)]">
						Click sets worker. Double-click promotes.
					</div>
				</div>

				<div className="flex min-h-0 flex-col p-4">
					<div className="mb-4 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
						<div>
							<div className="text-[18px] font-semibold leading-tight text-[color:var(--fg)]">Launch preview</div>
							<div className="font-mono text-[11px] text-[color:var(--fg-dim)]">
								same daemon route, different native CLI
							</div>
						</div>
						<div className="rounded-md border border-[color:var(--border)] bg-white/[0.025] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-[color:var(--fg-dim)]">
							ready
						</div>
					</div>

					<div className="overflow-hidden rounded-md border border-[color:var(--border)] bg-[#050507]">
						<div className="flex items-center gap-1.5 border-b border-[color:var(--border)] px-3 py-2">
							<span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
							<span className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
							<span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
							<span className="ml-3 font-mono text-[10px] text-[color:var(--fg-dim)]">ao spawn</span>
						</div>
						<div className="space-y-2 px-4 py-4 font-mono text-[12px] leading-relaxed">
							<TerminalLine muted text="$ ao spawn --project agent-orchestrator" />
							<TerminalLine text={`worker        ${worker.name}`} />
							<TerminalLine text={`orchestrator  ${orchestrator.name}`} />
							<TerminalLine accent text={`exec          ${worker.command}`} />
							<TerminalLine success text="workspace     .ao/worktrees/session-ao-204" />
							<TerminalLine success text="activity      hooks installed, session visible" />
							<TerminalPrompt />
						</div>
					</div>
					<div className="mt-auto border-t border-[color:var(--border)] pt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-dim)]">
						selected route stays local
					</div>
				</div>
			</div>
		</article>
	);
}

function AgentSelectLabel({
	label,
	agent,
	active,
	onClick,
}: {
	label: string;
	agent: AgentHarness;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button type="button" onClick={onClick} className="block w-full cursor-pointer text-left">
			<div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-dim)]">{label}</div>
			<div
				className={`flex items-center gap-2 rounded-md border px-2.5 py-2 transition duration-200 ${
					active ? "border-white/18 bg-white/[0.055]" : "border-[color:var(--border)] bg-white/[0.035]"
				}`}
			>
				<AgentLogo agent={agent} className="h-5 w-5" />
				<div className="min-w-0">
					<div className="truncate text-[12px] font-semibold text-[color:var(--fg)]">{agent.name}</div>
					<div className="truncate font-mono text-[10px] text-[color:var(--fg-dim)]">{agent.id}</div>
				</div>
			</div>
		</button>
	);
}

function AgentLogo({ agent, className }: { agent: AgentHarness; className: string }) {
	if (!agent.logo) {
		return (
			<div className={`${className} agent-logo-frame text-xs font-bold text-[color:var(--fg-muted)]`}>
				{agent.name.slice(0, 1)}
			</div>
		);
	}

	return (
		<span className={`${className} agent-logo-frame`}>
			<img src={agent.logo} alt="" referrerPolicy="no-referrer" className="agent-logo-image" />
		</span>
	);
}

function TerminalLine({
	text,
	muted,
	accent,
	success,
}: {
	text: string;
	muted?: boolean;
	accent?: boolean;
	success?: boolean;
}) {
	return (
		<div
			className={`landing-stream-line ${
				accent
					? "text-[color:var(--accent)]"
					: success
						? "text-[color:var(--status-ok)]"
						: muted
							? "text-[color:var(--fg-dim)]"
							: "text-[color:var(--fg-muted)]"
			}`}
		>
			{text}
		</div>
	);
}

/* Idle prompt with a blinking cursor - keeps the terminals feeling live. */
function TerminalPrompt() {
	return (
		<div className="flex items-center text-[color:var(--fg-dim)]">
			<span>$</span>
			<span className="caret ml-1" />
		</div>
	);
}

function WorkspaceIsolationDemo({
	activeId,
	onSelect,
	workspace,
}: {
	activeId: string;
	onSelect: (id: string) => void;
	workspace: (typeof workspaceSessions)[number];
}) {
	const [actionState, setActionState] = useState("session attached");

	return (
		<article className="surface relative h-[520px] w-full overflow-hidden p-0">
			<div className="grid h-full min-h-[500px] grid-cols-[210px_1fr]">
				<aside className="flex min-h-0 flex-col border-r border-[color:var(--border)] bg-[color:var(--bg-card)]">
					<div className="landing-card-header flex items-center justify-between px-4 py-3.5">
						<div className="flex min-w-0 items-center gap-2.5">
							<img src="/ao-logo-transparent.png" alt="" className="h-6 w-6 object-contain" />
							<div className="truncate text-[13px] font-semibold text-[color:var(--fg)]">Agent Orchestrator</div>
						</div>
						<div className="h-3 w-3 rounded-sm border border-[color:var(--border-strong)]" />
					</div>

					<div className="flex-1 overflow-hidden px-3 py-4">
						<div className="mb-3 flex items-center justify-between">
							<span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--fg-dim)]">
								Projects
							</span>
							<span className="font-mono text-[13px] text-[color:var(--fg-dim)]">+</span>
						</div>

						<div className="rounded-md bg-white/[0.045] px-3 py-2">
							<div className="flex items-center justify-between gap-2">
								<span className="truncate text-[13px] font-semibold text-[color:var(--fg)]">agent-orchestrator</span>
								<span className="rounded-md bg-black/35 px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--fg-dim)]">
									3
								</span>
							</div>
						</div>

						<div className="mt-2 space-y-1.5">
							{workspaceSessions.map((session) => (
								<button
									key={session.id}
									type="button"
									onClick={() => onSelect(session.id)}
									className={`group relative flex w-full cursor-pointer items-start gap-2 rounded-md px-3 py-2.5 text-left transition duration-200 hover:bg-white/[0.05] ${
										activeId === session.id ? "bg-white/[0.065]" : ""
									}`}
								>
									{activeId === session.id ? (
										<span className="absolute inset-y-2 left-0 w-px rounded-full bg-[color:var(--accent)]" />
									) : null}
									<span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: session.color }} />
									<div className="min-w-0">
										<div className="truncate text-[12px] leading-snug text-[color:var(--fg-muted)] group-hover:text-[color:var(--fg)]">
											{session.title}
										</div>
										<div className="mt-1 font-mono text-[9px] text-[color:var(--fg-dim)]">{session.id}</div>
									</div>
								</button>
							))}
						</div>
					</div>

					<div className="border-t border-[color:var(--border)] px-4 py-3">
						<div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--fg-dim)]">settings</div>
					</div>
				</aside>

				<div className="min-w-0">
					<div className="landing-card-header grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3.5">
						<div className="min-w-0">
							<div className="flex items-center gap-3">
								<h4 className="text-[18px] font-semibold leading-tight text-[color:var(--fg)]">Session</h4>
								<span
									className="rounded-full px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em]"
									style={{ color: workspace.color, background: `${workspace.color}1a` }}
								>
									{workspace.status}
								</span>
							</div>
							<div className="mt-1 truncate font-mono text-[11px] text-[color:var(--fg-dim)]">
								{workspace.agent} {"->"} {workspace.branch}
							</div>
						</div>
						<div className="flex shrink-0 gap-2">
							<button
								type="button"
								onClick={() => setActionState(`${workspace.id} restored`)}
								className="h-9 cursor-pointer rounded-md border border-[color:var(--border)] bg-white/[0.03] px-2.5 text-[12px] font-medium text-[color:var(--fg-muted)] transition hover:border-white/20 hover:bg-white/[0.06]"
							>
								Restore
							</button>
							<button
								type="button"
								onClick={() => setActionState(`PR opened for ${workspace.branch}`)}
								className="h-9 cursor-pointer rounded-md bg-[color:var(--accent)] px-3 text-[12px] font-semibold text-[#061126] transition hover:brightness-110"
							>
								Open PR
							</button>
						</div>
					</div>

					<div className="grid min-h-[415px] grid-cols-1">
						<div className="flex min-w-0 flex-col border-r border-[color:var(--border)]">
							<div className="flex items-center justify-between border-b border-[color:var(--border)] bg-white/[0.015] px-4 py-3">
								<div>
									<div className="text-[14px] font-semibold text-[color:var(--fg)]">{workspace.title}</div>
									<div className="mt-1 font-mono text-[10px] text-[color:var(--fg-dim)]">{workspace.path}</div>
								</div>
								<div className="rounded-md border border-[color:var(--border)] px-2 py-1 font-mono text-[10px] text-[color:var(--fg-dim)]">
									{workspace.id}
								</div>
							</div>

							<div className="flex-1 bg-[#020203] p-3.5">
								<div className="h-full overflow-hidden rounded-md border border-[color:var(--border)] bg-black">
									<div className="flex items-center gap-1.5 border-b border-[color:var(--border)] px-3 py-2">
										<span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
										<span className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
										<span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
										<span className="ml-3 font-mono text-[10px] text-[color:var(--fg-dim)]">terminal</span>
									</div>
									<div className="space-y-2 px-4 py-4 font-mono text-[12px] leading-relaxed">
										<TerminalLine muted text={`$ pwd`} />
										<TerminalLine text={`/repo/agent-orchestrator/${workspace.path}`} />
										<TerminalLine muted text="$ git status --short --branch" />
										<TerminalLine accent text={`## ${workspace.branch}`} />
										{workspace.files.map((file) => (
											<TerminalLine key={file} text={` M ${file}`} />
										))}
										<TerminalLine success text="main checkout untouched; session owns this diff" />
										<TerminalLine success text={`action        ${actionState}`} />
										<TerminalPrompt />
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</article>
	);
}

function WorkspaceNarrative({ workspace }: { workspace: (typeof workspaceSessions)[number] }) {
	return (
		<FeatureCopy
			eyebrow="Worktrees"
			title="Every task gets its own checkout."
			accent="Your main repo stays clean."
			meta={workspace.id}
		>
			<p>
				Each session runs in its own <FeatureStrong>git worktree</FeatureStrong> - separate branch, terminal, and diff.
				One agent can fail CI while another keeps shipping, and cleanup is just removing the worktree.
			</p>
		</FeatureCopy>
	);
}

function InspectorFact({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-md border border-[color:var(--border)] bg-black/25 px-3 py-2.5">
			<div className="font-mono text-[9px] uppercase tracking-[0.18em] text-[color:var(--fg-dim)]">{label}</div>
			<div className="mt-1 truncate font-mono text-[11px] text-[color:var(--fg-muted)]">{value}</div>
		</div>
	);
}

function FeedbackNarrative({ feedback }: { feedback: (typeof feedbackSessions)[number] }) {
	return (
		<FeatureCopy
			eyebrow="Review routing"
			title="Reviews route back to the owner."
			accent="Not to a random terminal."
			meta={feedback.number}
		>
			<p>
				AO watches <FeatureStrong>CI, reviews, and PR state</FeatureStrong>, then routes each result to the session that
				owns the branch - so the agent gets actionable context, not a vague “CI failed” ping you have to trace yourself.
			</p>
		</FeatureCopy>
	);
}

function FeedbackRoutingDemo({
	activeId,
	onSelect,
	feedback,
}: {
	activeId: string;
	onSelect: (id: string) => void;
	feedback: (typeof feedbackSessions)[number];
}) {
	const [sentSession, setSentSession] = useState<string | null>(null);

	return (
		<article className="surface relative h-[520px] w-full overflow-hidden p-0">
			<div className="landing-card-header flex items-center justify-between px-5 py-4">
				<div>
					<div className="text-sm font-semibold text-[color:var(--fg)]">Pull requests</div>
					<div className="font-mono text-[11px] text-[color:var(--fg-dim)]">
						CI, reviews and comments mapped to sessions
					</div>
				</div>
				<div className="rounded-md border border-[color:var(--border)] bg-white/[0.03] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
					lifecycle
				</div>
			</div>

			<div className="grid h-[calc(520px-77px)] grid-cols-[280px_1fr]">
				<aside className="flex min-h-0 flex-col border-r border-[color:var(--border)] bg-[color:var(--bg-card)] p-4">
					<div className="mb-3 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--fg-dim)]">
						Open PRs
					</div>
					<div className="space-y-2">
						{feedbackSessions.map((item) => (
							<button
								key={item.id}
								type="button"
								onClick={() => onSelect(item.id)}
								className={`relative w-full cursor-pointer rounded-md border px-3 py-3 text-left transition duration-200 hover:-translate-y-0.5 hover:border-white/15 hover:bg-white/[0.045] ${
									activeId === item.id
										? "border-white/18 bg-white/[0.055] shadow-[inset_0_0_0_1px_rgba(147,180,248,0.14)]"
										: "border-[color:var(--border)] bg-white/[0.02]"
								}`}
							>
								{activeId === item.id ? (
									<span className="absolute inset-y-3 left-0 w-px rounded-full bg-[color:var(--accent)] opacity-80" />
								) : null}
								<div className="flex items-center justify-between gap-3">
									<span className="font-mono text-[11px] text-[color:var(--fg-muted)]">{item.number}</span>
									<span
										className="rounded-full px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em]"
										style={{ color: item.color, background: `${item.color}18` }}
									>
										{item.state}
									</span>
								</div>
								<div className="mt-2 line-clamp-2 text-[13px] font-semibold leading-snug text-[color:var(--fg)]">
									{item.title}
								</div>
								<div className="mt-2 font-mono text-[10px] text-[color:var(--fg-dim)]">
									{item.agent} / {item.session}
								</div>
							</button>
						))}
					</div>
					<div className="mt-auto pt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-dim)]">
						owner matched
					</div>
				</aside>

				<div className="flex min-h-0 flex-col p-5">
					<div className="mb-5 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
						<div className="min-w-0 pr-2">
							<div className="flex items-center gap-3">
								<span className="font-mono text-[12px] text-[color:var(--fg-dim)]">{feedback.number}</span>
								<h4 className="truncate text-[18px] font-semibold leading-tight text-[color:var(--fg)]">
									{feedback.title}
								</h4>
							</div>
							<div className="mt-1 font-mono text-[11px] text-[color:var(--fg-dim)]">
								{feedback.branch} {"->"} {feedback.agent} session {feedback.session}
							</div>
						</div>
						<button
							type="button"
							onClick={() => setSentSession(feedback.session)}
							className="h-9 min-w-[68px] cursor-pointer rounded-md bg-[color:var(--accent)] px-3 text-[12px] font-semibold text-[#061126] transition hover:brightness-110"
						>
							{sentSession === feedback.session ? "Sent" : "Send"}
						</button>
					</div>

					<div>
						<div className="overflow-hidden rounded-md border border-[color:var(--border)] bg-black">
							<div className="flex items-center justify-between border-b border-[color:var(--border)] px-3 py-2">
								<div className="flex items-center gap-1.5">
									<span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
									<span className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
									<span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
								</div>
								<span className="font-mono text-[10px] text-[color:var(--fg-dim)]">ao send</span>
							</div>
							<div className="space-y-2 px-4 py-4 font-mono text-[12px] leading-relaxed">
								<TerminalLine muted text={`$ ao session claim-pr ${feedback.session} ${feedback.number}`} />
								<TerminalLine text={`owner         ${feedback.agent}`} />
								<TerminalLine text={`session       ${feedback.session}`} />
								<TerminalLine accent text={`message       ${feedback.nudge}`} />
								<TerminalLine
									success
									text={
										sentSession === feedback.session
											? "feedback routed to the running worker pane"
											: "ready to route feedback"
									}
								/>
								<TerminalPrompt />
							</div>
						</div>
					</div>
					<div className="mt-auto border-t border-[color:var(--border)] pt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-dim)]">
						feedback routes to session {feedback.session}
					</div>
				</div>
			</div>
		</article>
	);
}

function DaemonControlDemo() {
	return (
		<article className="surface relative h-[520px] w-full overflow-hidden p-0">
			<div className="landing-card-header flex items-center justify-between px-5 py-4">
				<div>
					<div className="text-sm font-semibold text-[color:var(--fg)]">Local control plane</div>
					<div className="font-mono text-[11px] text-[color:var(--fg-dim)]">
						desktop and CLI talk to the same daemon
					</div>
				</div>
				<div className="rounded-md border border-[color:var(--border)] bg-white/[0.03] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
					127.0.0.1
				</div>
			</div>

			<div className="grid min-h-[424px] grid-cols-[1fr_300px]">
				<div className="border-r border-[color:var(--border)] p-5">
					<div className="overflow-hidden rounded-md border border-[color:var(--border)] bg-black">
						<div className="flex items-center justify-between border-b border-[color:var(--border)] px-3 py-2">
							<div className="flex items-center gap-1.5">
								<span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
								<span className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
								<span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
							</div>
							<span className="font-mono text-[10px] text-[color:var(--fg-dim)]">ao doctor</span>
						</div>
						<div className="space-y-2 px-4 py-4 font-mono text-[12px] leading-relaxed">
							<TerminalLine muted text="$ ao start" />
							<TerminalLine success text="daemon started in background" />
							<TerminalLine muted text="$ ao status --json" />
							<TerminalLine text='{ "ready": true, "port": 3001, "bind": "127.0.0.1" }' />
							<TerminalLine muted text="$ ao doctor" />
							{daemonChecks.map((check) => (
								<TerminalLine key={check.label} success text={`✓ ${check.label.padEnd(9)} ${check.value}`} />
							))}
							<TerminalPrompt />
						</div>
					</div>
				</div>

				<aside className="bg-[color:var(--bg-card)] p-4">
					<div className="mb-4 flex items-center gap-3">
						<img src="/ao-logo-transparent.png" alt="" className="h-8 w-8 object-contain" />
						<div>
							<div className="text-[15px] font-semibold text-[color:var(--fg)]">AO daemon</div>
							<div className="font-mono text-[10px] text-[color:var(--fg-dim)]">agent-orchestrator-daemon</div>
						</div>
					</div>

					<div className="space-y-2">
						<InspectorFact label="bind" value="127.0.0.1" />
						<InspectorFact label="port" value="3001" />
						<InspectorFact label="data dir" value="~/.ao/data" />
						<InspectorFact label="store" value="SQLite + change_log" />
					</div>

					<div className="mt-5 rounded-md border border-[color:var(--border)] bg-white/[0.025] p-3">
						<div className="mb-2 flex items-center gap-2">
							<span className="landing-sse-pulse h-1.5 w-1.5 rounded-full bg-[color:var(--status-ok)]" />
							<span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
								live
							</span>
						</div>
						<p className="text-[12px] leading-relaxed text-[color:var(--fg-dim)]">
							The Electron app and `ao` CLI are just clients. The daemon owns sessions, worktrees, lifecycle and events.
						</p>
					</div>
				</aside>
			</div>
		</article>
	);
}

function DaemonNarrative() {
	return (
		<FeatureCopy
			eyebrow="Local daemon"
			title="Desktop and CLI share one brain."
			accent="A local daemon owns the loop."
			meta="127.0.0.1"
		>
			<p>
				The desktop app and <FeatureStrong>ao</FeatureStrong> CLI are clients of one local daemon that owns{" "}
				<FeatureStrong>sessions, worktrees, and live events</FeatureStrong>. Start in the terminal, inspect in the app -
				same control plane.
			</p>
		</FeatureCopy>
	);
}

function FeatureCopy({
	eyebrow,
	title,
	accent,
	children,
	meta,
}: {
	eyebrow: string;
	title: string;
	accent: string;
	children: ReactNode;
	meta?: string;
}) {
	return (
		<article className="feature-copy relative flex flex-col justify-center py-6">
			<div className="max-w-[40rem]">
				<div className="swap-item mb-7 flex items-center gap-4">
					<div className="landing-eyebrow landing-eyebrow-accent">{eyebrow}</div>
					{meta ? (
						<div className="inline-flex items-center rounded-full border border-[color:var(--accent-glow)] bg-[color:var(--accent-soft)] px-3 py-1.5 font-mono text-[12px] font-medium tracking-wide text-[color:var(--accent)]">
							{meta}
						</div>
					) : null}
				</div>
				<h3 className="swap-item landing-heading feature-heading max-w-[640px]">
					{title}
					<span className="landing-heading-muted block">{accent}</span>
				</h3>
				<div className="swap-item landing-body mt-9 space-y-5">{children}</div>
			</div>
		</article>
	);
}

function FeatureStrong({ children }: { children: ReactNode }) {
	return <span className="font-medium text-[color:var(--fg)]">{children}</span>;
}
